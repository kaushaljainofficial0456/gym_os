"""
Does self-reported effort (RPE) actually track energy expenditure?

This matters because the proposed SK OS design uses a post-session
easy/moderate/hard rating as the PRIMARY driver of the calorie estimate.
If self-reported effort does not track actual energy cost, that design has
a structural problem no amount of tuning fixes.

DATA: Adeel et al. 2021, Appl. Sci. 11(18):8773, CC BY 4.0, Tables 2 & 5.
Transcribed directly from the published tables (see add_adeel_cluster.py).
This is the ONLY dataset in our whole collection that reports BOTH a
subjective effort rating AND measured indirect-calorimetry energy cost for
the SAME sessions in the SAME people -- which makes it uniquely able to
answer this specific question.

Two groups: untrained (n=5, all women, 53.3kg) and trained (n=6, 4M/2F,
81.7kg), performing the SAME three exercises at the SAME relative
intensity (60% of each person's own 1RM).
"""

GROUP_WEIGHT_KG = {"untrained": 53.32, "trained": 81.68}

# Adeel Table 5 -- "During Exercise" MET, and RPE (Borg 6-20 scale)
DATA = {
    "shoulder_press": {
        "met":  {"untrained": 1.30, "trained": 2.02},
        "rpe":  {"untrained": 10.40, "trained": 10.03},
        "rpe_p": 0.118,   # NOT significant
        "met_p": 0.000,   # significant
    },
    "deadlift": {
        "met":  {"untrained": 2.71, "trained": 3.13},
        "rpe":  {"untrained": 10.60, "trained": 10.69},
        "rpe_p": 0.732,   # NOT significant
        "met_p": 0.000,
    },
    "squat": {
        "met":  {"untrained": 2.70, "trained": 3.42},
        "rpe":  {"untrained": 11.07, "trained": 11.69},
        "rpe_p": 0.036,   # significant, but see magnitude
        "met_p": 0.000,
    },
}


def met_to_kcal_min(met, weight_kg):
    return met * 3.5 * weight_kg / 200


print("=" * 84)
print("DOES SELF-REPORTED EFFORT TRACK ACTUAL ENERGY EXPENDITURE?")
print("Adeel 2021 -- same exercises, same relative intensity (60% 1RM), two groups")
print("=" * 84)
print()
print(f"{'exercise':<17}{'group':<12}{'RPE':<8}{'MET':<8}{'kcal/min':<11}{'body wt'}")
print("-" * 84)
for ex, d in DATA.items():
    for grp in ("untrained", "trained"):
        bw = GROUP_WEIGHT_KG[grp]
        kcal = met_to_kcal_min(d["met"][grp], bw)
        print(f"{ex:<17}{grp:<12}{d['rpe'][grp]:<8.2f}{d['met'][grp]:<8.2f}{kcal:<11.2f}{bw:.1f}kg")

print()
print("=" * 84)
print("THE RATIO THAT MATTERS (trained / untrained):")
print("=" * 84)
print(f"{'exercise':<17}{'RPE ratio':<14}{'kcal/min ratio':<18}{'RPE p-value':<14}{'MET p-value'}")
print("-" * 84)
for ex, d in DATA.items():
    rpe_ratio = d["rpe"]["trained"] / d["rpe"]["untrained"]
    kcal_u = met_to_kcal_min(d["met"]["untrained"], GROUP_WEIGHT_KG["untrained"])
    kcal_t = met_to_kcal_min(d["met"]["trained"], GROUP_WEIGHT_KG["trained"])
    kcal_ratio = kcal_t / kcal_u
    sig_rpe = "ns" if d["rpe_p"] > 0.05 else f"{d['rpe_p']:.3f}"
    print(f"{ex:<17}{rpe_ratio:<14.2f}{kcal_ratio:<18.2f}{sig_rpe:<14}{d['met_p']:.3f}")

print()
avg_rpe_ratio = sum(d["rpe"]["trained"] / d["rpe"]["untrained"] for d in DATA.values()) / len(DATA)
avg_kcal_ratio = sum(
    met_to_kcal_min(d["met"]["trained"], GROUP_WEIGHT_KG["trained"])
    / met_to_kcal_min(d["met"]["untrained"], GROUP_WEIGHT_KG["untrained"])
    for d in DATA.values()
) / len(DATA)
print(f"AVERAGE:  RPE ratio {avg_rpe_ratio:.2f}x   vs   actual energy ratio {avg_kcal_ratio:.2f}x")
print()
print("FINDING:")
print(f"  Trained participants burned {avg_kcal_ratio:.1f}x the calories of untrained participants")
print(f"  while reporting effort that was essentially IDENTICAL ({avg_rpe_ratio:.2f}x, and")
print("  statistically indistinguishable on 2 of 3 exercises).")
print()
print("WHY: perceived effort is relative to a person's OWN capacity. Working at")
print("60% of your max feels about the same regardless of how big that max is --")
print("but 60% of a large max costs far more energy in absolute terms.")
print()
print("IMPLICATION FOR THE PROPOSED DESIGN:")
print("  A self-reported easy/moderate/hard rating is NOT a reliable proxy for")
print("  absolute calorie burn. In this data it would have assigned the trained")
print("  and untrained groups nearly the same intensity -- while their true energy")
print("  cost differed ~2x. Using the rating as the PRIMARY driver would")
print("  systematically UNDER-estimate exactly the stronger/heavier lifter the")
print("  proposal is trying to correct upward.")
print()
print("NOTE THE CONFOUND, STATED HONESTLY: the trained group was also heavier")
print(f"  ({GROUP_WEIGHT_KG['trained']}kg vs {GROUP_WEIGHT_KG['untrained']}kg). Body weight drives a large part of")
print("  that 2x gap -- which REINFORCES the conclusion: the objective variable")
print("  (body weight, already in the app) carries the signal, not the self-report.")
