# Nutrition Phase 2 — Progress Log

Branch `feature/nutrition-engine-overhaul` · Phase 2 ran 2026-11-15 → 2026-11-16 · `main` untouched throughout.

Status keys: **Completed** · **Partially completed** · **Not implemented** · **Blocked** · **Requires external validation**.

## Git and safety record

- Every Phase 2 commit is on `feature/nutrition-engine-overhaul` and was pushed there only.
  - Before each push, the remote branch was fetched and checked to be an ancestor of local `HEAD` (fast-forward only).
  - There was no force-push, rebase or reset, and no branch was deleted.
- **`main`:** nothing was committed, pushed or merged to it, and no pull request was opened.
  - `main` has moved on its own from teammates' work, to `3fb3907`.
  - A merge was tried only in a throwaway detached worktree, now removed. It shows one trivial conflict in `.github/workflows/test.yml`: both sides added a CI step, and the fix is to keep both. With that resolved, the backend suite passes (2,226 / 0).
- **Approval-gated items were left for the owner:**
  - no production data changed;
  - no paid service added (photo estimation stays unexposed);
  - no attribution or licensing text changed (drafted only);
  - no destructive database change (all migrations add columns or tables).
- The temporary PostgreSQL clusters used for RLS tests were created under `/var/lib/postgresql/skos-test-cluster`, then stopped and removed after each use.
- **Correction to a pushed commit message.** `267fba3` says "153 foods at explicit weights, three phrasings each". It is **51 foods × 3 phrasings = 153 cases**. The message cannot be amended without a force-push, so it is corrected here.

## Commits

| Commit | What | Findings closed |
|---|---|---|
| `ab44aae` | Phase 2 audit | — |
| `a6dcda5` | Shared-value poisoning, "half a plate" → veal, sabudana khichdi double count | F1, F2, F3 |
| `08c98e6` | Container sizes, size words | F4, F5 |
| `2e671ac` | 14 staples recomputed; dal and mutton corrected; recipe oil baselines | F6 |
| `8569add` | Raw/dry vs cooked, trailing amounts, bowl of a dry food, nut toppings (also F12) | F6, F12 (partly) |
| `1e316b6` | Accuracy report; `total_incomplete` | — |
| `b3eb7a3` | Classic sheet server-priced and idempotent; provenance visible | F7, F8 |
| `c4422e7` | Corrections, personal learning, reviewed shared mappings | F9 |
| `317fd36` | Activity level, diet defaults, foods-to-avoid flags | F11 |
| `267fba3` | Benchmark v3 (945), new metrics, engine fixes it exposed | F14 (partly) |
| `8b5f93d` | Licensing, real-world validation protocol, image decision | F10, F13 (documented) |
| *(this commit)* | Commercial readiness scorecard, this log, accuracy report addendum | — |

## Phase 2 audit findings: final status

| # | Finding | Status |
|---|---|---|
| F1 | One user could rewrite a shared AI value | **Completed**: distinct-people threshold, then admin approval |
| F2 | "Half a plate" became USDA veal | **Completed** |
| F3 | Sabudana khichdi counted twice | **Completed** |
| F4 | Katori priced as a bowl-sized serving | **Completed** |
| F5 | Size words ignored | **Completed** |
| F6 | Questionable references (dal 145) and hand-typed staples | **Completed** for 14 staples; **Partially completed**: 10 inline values remain |
| F7 | Classic sheet bypassed server pricing and idempotency | **Completed** |
| F8 | Provenance invisible | **Completed** |
| F9 | No user corrections | **Completed** |
| F10 | Image estimation only in dead code | **Not implemented** by decision: needs an owner-approved paid provider; grounded design recorded |
| F11 | Personalization gaps | **Completed** |
| F12 | "Poha with peanuts" garnish | **Partially completed**: 10 g topping, flagged as assumed; whether INDB poha already includes peanuts **Requires external validation** |
| F13 | Licensing | **Blocked**: IFCT permission and INDB licence need third parties; attribution needs owner approval |
| F14 | No real-world data | **Requires external validation**: protocol written; in-product signals in place |

## Defects found during Phase 2 beyond the audit (all fixed and tested)

- **Raw/dry vs cooked:**
  - "raw rice" was puffed rice;
  - "uncooked moong dal" was a cooked dal at about ⅕ of its energy;
  - "dry chana" was cabbage rolls;
  - "raw potato" was potato pancake;
  - "atta" was atta burfi;
  - "raw oats" was a branded protein-oat product;
  - "cooked soya chunks" used the dry values;
  - "1 bowl oats" was 973 kcal.
- **Trailing amounts:** "chicken breast 200g" lost its 200 g; "paneer 100 g", "dal 1 bowl" and "roti 2" were unresolved.
- **Wrong foods and sizes:**
  - "1 tomato" was a 20 g slice of green tomato;
  - a cup of mushrooms was 240 g;
  - "beetroot" was a beetroot-egg salad;
  - "1 slice cheddar" was 100 g;
  - "tomato rice" was a beef dish.
- **Spellings and phrasing:** "panner", "prantha", "raitha"; "breakfast was …"; "a couple of rotis".
- **Oil choices:**
  - oats porridge offered an oil choice for milk fat;
  - paneer bhurji could not offer "more oil";
  - home dal could not offer "less oil".
- Drinks computed from recipes were classed as dishes.
- Meal totals counted an unmeasured nutrient as a measured 0. Estimates now report this; stored logs still don't (see the open list below).

## Benchmark record

| Dataset | Cases | Score at Phase 2 start | Score now | Note |
|---|---:|---:|---:|---|
| v1 | 324 | 83.5% | 84.0% | Three v1 specs corrected (wild/glutinous rice references; "cooked" matched "uncooked"); logged in the benchmark README |
| v2 | 534 | 86.5% | 87.1% | |
| v3 | 945 | — | 90.4% (Phase 1 engine: 86.5%) | New; multi-source ground truth |

Every re-baseline is logged with its reason in `ml/data/benchmark/README.md`. No case got worse at any re-baseline, except three documented −0.01 to −0.05 changes from the P2-2 container fix.

## Open items (carried forward)

- **Blocked:** IFCT 2017 written permission; INDB licence confirmation; OFF and CNF attribution (owner approval).
- **Requires external validation:**
  - weighed-plate study;
  - recipe proportions;
  - restaurant oil;
  - whether INDB's poha already includes peanuts.
- **Not implemented:**
  - nullable stored macros;
  - per-recipe oil baselines for INDB dishes;
  - AI meal decomposition for unresolved sentences;
  - photo estimation (owner decision);
  - load and penetration tests;
  - browser end-to-end tests.
- **Known engine gaps:**
  - dry poha has no measured row;
  - "raw banana" (green plantain) has no IFCT row;
  - "chicken 65" resolves to ground chicken at low confidence;
  - "dalia" and "sabudana" with no state word resolve to the dish;
  - meal-level confidence is under-confident (ECE 0.45 for meals).
