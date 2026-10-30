"""
Leakage-safe evaluation splits.

The unit of independence is the PERSON (cross-study key when available,
else participant id), and above that the STUDY/site. A person's sessions are
never split across train and test, and leave-one-study-out keeps whole
studies out. Every split is checked, not assumed.
"""
import numpy as np


class LeakageError(AssertionError):
    pass


def assert_no_leakage(train, test, columns=('person_key', 'session_id')):
    for c in columns:
        shared = set(train[c]) & set(test[c])
        if shared:
            raise LeakageError(f'{len(shared)} {c} value(s) appear in both train and test, e.g. {sorted(shared)[:3]}')


def person_folds(sessions, k=5, seed=0):
    """Grouped k-fold over people; yields (train_idx, test_idx)."""
    people = np.array(sorted(sessions['person_key'].unique()))
    if len(people) < k:
        raise ValueError(f'{len(people)} people cannot make {k} person-grouped folds')
    rng = np.random.default_rng(seed)
    rng.shuffle(people)
    for fold in np.array_split(people, k):
        test = sessions['person_key'].isin(fold)
        tr, te = sessions[~test], sessions[test]
        assert_no_leakage(tr, te)
        yield tr.index, te.index


def leave_one_study_out(sessions):
    """Yields (study_id, train_idx, test_idx). A person seen in two studies
    is removed from training when either study is held out."""
    for study in sorted(sessions['study_id'].unique()):
        test = sessions['study_id'] == study
        held_people = set(sessions.loc[test, 'person_key'])
        train = ~test & ~sessions['person_key'].isin(held_people)
        tr, te = sessions[train], sessions[test]
        assert_no_leakage(tr, te)
        yield study, tr.index, te.index
