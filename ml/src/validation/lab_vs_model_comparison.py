"""
Side-by-side: lab measurement vs what our model actually returns.

WHY BOTH COLUMNS MATTER:
"How accurate is the model" has two honest answers depending on whether
the food is IN the database:

  NORMAL OPERATION -- the food is present, so the model returns the lab
      measurement itself. Accuracy is the measurement's accuracy.
  HELD-OUT -- IFCT is removed entirely and the model must answer from
      USDA/INDB/CNF/OFF alone. This is the hard case: a food nobody has
      measured in our data.

Reporting only the first would be self-congratulatory (comparing a value
to itself); reporting only the second would understate what a user
actually experiences, because most logged foods ARE in the database.
Both are shown, per food, with the difference in percent.
"""
import json
import os
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC))
sys.path.insert(0, str(SRC / "validation"))

from inference.food_search import FoodSearch  # noqa: E402

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
TMP = PROC / "_lab_compare_db.json"

# Well-known foods a user would plausibly log, spanning macros and food
# groups. Chosen before running, not picked to flatter the result.
FOODS = [
    ("Paneer", "paneer"),
    ("Egg, poultry, whole, raw", "egg"),
    ("Milk, whole, Cow", "milk"),
    ("Spinach (Spinacia oleracea)", "spinach"),
    ("Chicken, poultry, breast, skinless", "chicken breast"),
    ("Wheat flour, atta (Triticum aestivum)", "wheat flour"),
    ("Almond (Prunus amygdalus)", "almond"),
    ("Cashew nut (Anacardium occidentale)", "cashew"),
    ("Walnut (Juglans regia)", "walnut"),
    ("Groundnut (Arachis hypogaea)", "groundnut"),
    ("Bengal gram, dal (Cicer arietinum)", "bengal gram dal"),
    ("Green gram, dal (Vigna radiata)", "green gram dal"),
    ("Black gram, dal (Phaseolus mungo)", "black gram dal"),
    ("Soya bean, white (Glycine max)", "soya bean"),
    ("Cauliflower (Brassica oleracea var. botrytis)", "cauliflower"),
    ("Cabbage (Brassica oleracea var. capitata)", "cabbage"),
    ("Carrot, orange (Daucus carota)", "carrot"),
    ("Tomato, ripe (Solanum lycopersicum)", "tomato"),
    ("Onion, big (Allium cepa)", "onion"),
    ("Cucumber (Cucumis sativus)", "cucumber"),
    ("Brinjal - all varieties (Solanum melongena)", "brinjal"),
    ("Ladies finger (Abelmoschus esculentus)", "ladies finger"),
    ("Apple, big (Malus domestica)", "apple"),
    ("Guava, white flesh (Psidium guajava)", "guava"),
    ("Papaya, ripe (Carica papaya)", "papaya"),
    ("Pomegranate (Punica granatum)", "pomegranate"),
    ("Grapes, seedless (Vitis vinifera)", "grapes"),
    ("Curd (Dahi)", "curd"),
    ("Ghee (Butter oil)", "ghee"),
    ("Coconut, fresh (Cocos nucifera)", "coconut"),
]

FIELDS = [("energy_kcal", "kcal"), ("protein_g", "protein g"),
          ("fat_g", "fat g"), ("carb_g", "carb g")]


def pct(pred, lab):
    if pred is None or lab in (None, 0):
        return None
    return (pred - lab) / lab * 100.0


def main():
    db = json.loads((PROC / "unified_food_db.json").read_text(encoding="utf-8"))
    ifct = {f["food_name"]: f for f in db if f["source"] == "IFCT2017"}

    TMP.write_text(json.dumps([f for f in db if f["source"] != "IFCT2017"]),
                   encoding="utf-8")
    held = FoodSearch(db_path=TMP)     # hardest case: this food is unknown
    full = FoodSearch()                # normal operation

    print("LAB MEASUREMENT (IFCT 2017) vs OUR MODEL  --  per 100 g\n")
    print(f"{'query':16s} {'LAB':>8s} {'MODEL':>8s} {'diff':>7s}   "
          f"{'HELD-OUT':>9s} {'diff':>7s}   matched (held-out)")
    print("-" * 92)

    normal_err, held_err = [], []
    for name, q in FOODS:
        gt = ifct.get(name)
        if not gt or gt.get("energy_kcal") is None:
            continue
        lab = gt["energy_kcal"]
        a = full.search(q, limit=1)
        b = held.search(q, limit=1)
        av = a[0]["energy_kcal"] if a else None
        bv = b[0]["energy_kcal"] if b else None
        bn = b[0]["food_name"][:30] if b else "-"

        da, dbb = pct(av, lab), pct(bv, lab)
        if da is not None:
            normal_err.append(abs(da))
        if dbb is not None:
            held_err.append(abs(dbb))

        print(f"{q[:16]:16s} {lab:8.1f} "
              f"{(av if av is not None else float('nan')):8.1f} "
              f"{(f'{da:+.0f}%' if da is not None else '-'):>7s}   "
              f"{(bv if bv is not None else float('nan')):9.1f} "
              f"{(f'{dbb:+.0f}%' if dbb is not None else '-'):>7s}   {bn}")

    def summarise(label, errs):
        if not errs:
            return
        errs = sorted(errs)
        med = errs[len(errs) // 2]
        print(f"  {label:28s} median |error| {med:5.1f}%   "
              f"-> ~{100-med:.0f}% accurate   "
              f"(worst {max(errs):.0f}%)")

    print("\nSUMMARY")
    summarise("food IS in the database", normal_err)
    summarise("food is UNKNOWN (held out)", held_err)

    # macro-level detail for a couple of foods
    print("\nMACRO DETAIL (normal operation)")
    for name, q in FOODS[:4]:
        gt = ifct.get(name)
        r = full.search(q, limit=1)
        if not gt or not r:
            continue
        m = r[0]
        parts = []
        for f, lbl in FIELDS:
            lv, mv = gt.get(f), m.get(f)
            if lv is None or mv is None:
                parts.append(f"{lbl}: n/a")
            else:
                parts.append(f"{lbl}: {lv:.1f} vs {mv:.1f}")
        print(f"  {q:16s} " + " | ".join(parts))

    try:
        os.remove(TMP)
    except OSError:
        pass


if __name__ == "__main__":
    main()
