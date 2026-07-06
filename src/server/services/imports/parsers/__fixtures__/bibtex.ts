// Golden BibTeX fixtures — Zotero-style export (4 records) + malformed variants.

export const BIBTEX_ZOTERO_4 = `@article{criner_liberate_2018,
	title = {A Multicenter Randomized Controlled Trial of Zephyr Endobronchial Valve Treatment in Heterogeneous Emphysema ({LIBERATE})},
	volume = {198},
	issn = {1535-4970},
	doi = {10.1164/rccm.201803-0590OC},
	abstract = {Rationale: This multicenter randomized controlled trial evaluated the effectiveness
and safety of Zephyr Endobronchial Valve in heterogeneous emphysema.},
	number = {9},
	journal = {American Journal of Respiratory and Critical Care Medicine},
	author = {Criner, Gerard J. and Sue, Richard and Wright, Shawn and Dransfield, Mark},
	year = {2018},
	pmid = {29787288},
	pages = {1151--1164},
}

@article{muller_diaphragm_2020,
	title = "Diaphragm ultrasound in {COPD}: reproducibility of thickening fraction measurements",
	volume = "75",
	doi = "10.1136/thoraxjnl-2019-213456",
	number = "4",
	journal = "Thorax",
	author = "Müller, Jürgen and García-López, María",
	year = "2020",
	pages = "331--339",
	url = "https://thorax.bmj.com/content/75/4/331",
}

@inproceedings{smith_ml_2021,
	title = {Machine learning for screening prioritisation in systematic reviews},
	booktitle = {Proceedings of the 2021 Evidence Synthesis Methods Conference},
	author = {Smith, John A. and O'Brien, Siobhán},
	year = {2021},
	pages = {12--19},
}

@article{lee_telehealth_2022,
	title = {Telehealth-delivered pulmonary rehabilitation: a systematic review and meta-analysis},
	journal = {Chest},
	author = {Lee, Annemarie L.},
	year = {2022},
	volume = {161},
	number = {6},
	doi = {10.1016/j.chest.2022.01.041},
	language = {english},
}
`;

// A good entry, an entry missing a title, and an unterminated entry at EOF.
export const BIBTEX_MALFORMED = `@article{good_2019,
	title = {A perfectly valid entry},
	author = {Doe, Jane},
	year = {2019},
	journal = {Journal of Robust Parsing},
}

@article{no_title_2018,
	author = {Titleless, Terry},
	year = {2018},
	journal = {Journal of Missing Fields},
}

@article{unterminated_2022,
	title = {This entry never closes its braces,
	author = {Endless, Eva},
	year = {2022},
`;

export const BIBTEX_EMPTY = "";

// Prose only — no entries at all.
export const BIBTEX_NO_ENTRIES = "This is just a text file with no BibTeX entries in it.\n";
