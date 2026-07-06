// Golden CSV fixtures — 5 records with realistic headers + malformed variants.

export const CSV_5 = `Title,Authors,Year,Journal,Volume,Issue,Pages,DOI,PMID,URL,Language,Abstract
"Endobronchial valves for emphysema: 5-year outcomes","Criner, Gerard J.; Sue, Richard",2023,American Journal of Respiratory and Critical Care Medicine,207,3,266-278,10.1164/rccm.202207-1373OC,36150166,https://pubmed.ncbi.nlm.nih.gov/36150166/,eng,"BACKGROUND: Long-term outcomes of valve therapy remain uncertain.
METHODS: We followed the LIBERATE cohort for five years."
"Diaphragm ultrasound reproducibility in COPD","Müller, Jürgen; García-López, María",2020,Thorax,75,4,331-339,https://doi.org/10.1136/thoraxjnl-2019-213456,,https://thorax.bmj.com/content/75/4/331,eng,Diaphragm dysfunction is common in COPD.
"Pulmonary rehabilitation after COPD exacerbations","Puhan, Milo A.; Gimeno-Santos, Elena",2016,Cochrane Database of Systematic Reviews,,12,,10.1002/14651858.CD005305.pub4,27930803,,eng,
"Nocturnal non-invasive ventilation in stable hypercapnic COPD","Koehnlein, Thomas",2014,The Lancet Respiratory Medicine,2,9,698-705,10.1016/S2213-2600(14)70153-5,25066329,,eng,Non-invasive ventilation targeted to reduce hypercapnia.
"Smoking cessation in pulmonary clinics","Nguyen, Thi Hoang Lan",2021,Respiratory Research,22,,145,,PMID: 34059074,,eng,Pragmatic cohort of smoking cessation support.
`;

// Alternate header aliases (TI/AU/PY/Source) — exercises the alias map.
export const CSV_ALIAS_HEADERS = `TI,AU,PY,Source,DO
"Alias headers still parse","Doe, Jane; Roe, Richard",2019,Journal of Header Aliases,10.1000/alias.1
`;

// Row 2 is missing its title.
export const CSV_MISSING_TITLE = `Title,Authors,Year,Journal
"A valid row","Doe, Jane",2019,Journal of Robust Parsing
,"Titleless, Terry",2018,Journal of Missing Fields
"Another valid row","Fine, Frank",2015,Journal of Recovery
`;

// Header only — no data rows.
export const CSV_HEADER_ONLY = "Title,Authors,Year,Journal\n";

export const CSV_EMPTY = "";
