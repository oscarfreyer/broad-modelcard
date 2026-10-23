// Short names of the ICD-11 subchapters (blocks) around a chapter circle
//. One or two
// plain words chosen to fit each block's arc at the one label size
// (arcLabels.planGroupLabel; tests/chapterGroupLabels.test.js checks every
// block shown). A name that does not fit is left out, never scaled. The full ICD-11 title stays the block's name on
// hover, in the card, and for screen readers. UI copy keyed by block concept
// id, not ontology data; a block without an entry keeps its title, and the
// group of small blocks a chapter folds together reads "Other".

const SHORT_NAMES = Object.freeze({
  // 01 Certain infectious or parasitic diseases
  'BLK-01-BlockL1-1A0': 'Gut infections',
  'BLK-01-BlockL1-1A6': 'STIs',
  'BLK-01-BlockL1-1B1': 'TB, leprosy',
  'BLK-01-BlockL1-1B7': 'Pyoderma',
  'BLK-01-BlockL1-1C1': 'Other bacterial',
  'BLK-01-BlockL1-1D0': 'Brain',
  'BLK-01-BlockL1-1D6': 'Zoonotic',
  'BLK-01-BlockL1-1D8': 'Viral',
  'BLK-01-BlockL1-1E7': 'Viral rashes',
  'BLK-01-BlockL1-1F2': 'Fungal',
  'BLK-01-BlockL1-1F4': 'Parasitic',
  // 02 Neoplasms
  'BLK-02-BlockL1-2A0': 'Brain',
  'BLK-02-BlockL1-2A2': 'Blood & lymph',
  'BLK-02-BlockL1-2B5': 'Malignant',
  'BLK-02-BlockL1-2E6': 'In situ',
  'BLK-02-BlockL1-2E8': 'Benign',
  // 03 Diseases of the blood or blood-forming organs
  'BLK-03-BlockL1-3A0': 'Anaemias, red cells',
  'BLK-03-BlockL1-3B1': 'Bleeding & clotting',
  'BLK-03-BlockL1-3B8': 'Spleen',
  // 04 Diseases of the immune system
  'BLK-04-BlockL1-4A0': 'Immunodeficiency',
  'BLK-04-BlockL1-4A4': 'Systemic autoimmune',
  'BLK-04-BlockL1-4A6': 'Inflammatory',
  'BLK-04-BlockL1-4A8': 'Allergies',
  'BLK-04-BlockL1-4B0': 'White cell disorders',
  'BLK-04-BlockL1-4B2': 'Other immune',
  // 05 Endocrine, nutritional or metabolic diseases
  'BLK-05-BlockL1-5A0': 'Endocrine',
  'BLK-05-BlockL1-5B5': 'Nutritional',
  'BLK-05-BlockL1-5C5': 'Metabolic',
  // 06 Mental, behavioural or neurodevelopmental disorders
  'BLK-06-BlockL1-6A0': 'Development',
  'BLK-06-BlockL1-6A2': 'Psychosis',
  'BLK-06-BlockL1-6A6': 'Mood',
  'BLK-06-BlockL1-6B2': 'OCD',
  'BLK-06-BlockL1-6B6': 'Dissociative',
  'BLK-06-BlockL1-6C4': 'Substance use',
  'BLK-06-BlockL1-6D7': 'Neurocognitive',
  // 07 Sleep-wake disorders
  'BLK-07-BlockL1-7A2': 'Hypersomnolence',
  'BLK-07-BlockL1-7A4': 'Sleep breathing',
  'BLK-07-BlockL1-7A8': 'Sleep movement',
  'BLK-07-BlockL1-7B0': 'Parasomnias',
  // 08 Diseases of the nervous system
  'BLK-08-BlockL1-8A0': 'Movement',
  'BLK-08-BlockL1-8A4': 'White matter',
  'BLK-08-BlockL1-8A6': 'Epilepsy',
  'BLK-08-BlockL1-8A8': 'Headache',
  'BLK-08-BlockL1-8B0': 'Cerebrovascular',
  'BLK-08-BlockL1-8B8': 'Peripheral nerves',
  'BLK-08-BlockL1-8C6': 'Neuromuscular',
  'BLK-08-BlockL1-8D4': 'Toxic',
  'BLK-08-BlockL1-8D6': 'Brain fluid',
  'BLK-08-BlockL1-8D8': 'Autonomic',
  'BLK-08-BlockL1-8E4': 'Other nervous',
  // 09 Diseases of the visual system
  'BLK-09-BlockL1-9A0': 'Eyelids & orbit',
  'BLK-09-BlockL1-9A6': 'Front of the eye',
  'BLK-09-BlockL1-9B5': 'Back of the eye',
  'BLK-09-BlockL1-9C4': 'Optic nerve',
  'BLK-09-BlockL1-9C6': 'Glaucoma',
  'BLK-09-BlockL1-9C8': 'Eye movement',
  'BLK-09-BlockL1-9D4': 'Vision loss',
  // 10 Diseases of the ear or mastoid process
  'BLK-10-BlockL1-AA0': 'Outer ear',
  'BLK-10-BlockL1-AA8': 'Middle ear',
  'BLK-10-BlockL1-AB3': 'Inner ear',
  'BLK-10-BlockL1-AB5': 'Hearing loss',
  'BLK-10-BlockL1-AB7': 'Other ear',
  // 11 Diseases of the circulatory system
  'BLK-11-BlockL1-BA4': 'Ischaemic heart',
  'BLK-11-BlockL1-BB0': 'Pulmonary',
  'BLK-11-BlockL1-BB6': 'Heart valves',
  'BLK-11-BlockL1-BC4': 'Heart muscle',
  'BLK-11-BlockL1-BC6': 'Arrhythmia',
  'BLK-11-BlockL1-BD3': 'Arteries',
  'BLK-11-BlockL1-BD7': 'Veins',
  'BLK-11-BlockL1-BD9': 'Lymphatic',
  'BLK-11-BlockL1-BE1': 'After surgery',
  // 12 Diseases of the respiratory system
  'BLK-12-BlockL1-CA0': 'Upper airways',
  'BLK-12-BlockL1-CA2': 'Lower airways',
  'BLK-12-BlockL1-CA4': 'Lung infections',
  'BLK-12-BlockL1-CA6': 'External agents',
  'BLK-12-BlockL1-CB0': 'Interstitial lung',
  'BLK-12-BlockL1-CB2': 'Pleura',
  // 13 Diseases of the digestive system
  'BLK-13-BlockL1-DA0': 'Mouth & face',
  'BLK-13-BlockL1-DA2': 'Oesophagus',
  'BLK-13-BlockL1-DA4': 'Stomach & duodenum',
  'BLK-13-BlockL1-DA9': 'Small bowel',
  'BLK-13-BlockL1-DB3': 'Large bowel',
  'BLK-13-BlockL1-DB5': 'Anal canal',
  'BLK-13-BlockL1-DB9': 'Liver',
  'BLK-13-BlockL1-DC1': 'Gallbladder',
  'BLK-13-BlockL1-DC3': 'Pancreas',
  'BLK-13-BlockL1-DC7': 'Diverticular',
  'BLK-13-BlockL1-DD9': 'Functional',
  // 14 Diseases of the skin
  'BLK-14-BlockL1-EA8': 'Inflammatory',
  'BLK-14-BlockL1-EC1': 'Genetic skin',
  'BLK-14-BlockL1-EC9': 'Itch, psyche',
  'BLK-14-BlockL1-ED5': 'Hair, nails, glands',
  'BLK-14-BlockL1-EH6': 'Drug effects',
  'BLK-14-BlockL1-EH9': 'External factors',
  'BLK-14-BlockL1-EL5': 'Surgical',
  // 15 Diseases of the musculoskeletal system or connective tissue
  'BLK-15-BlockL1-FA0': 'Joints',
  'BLK-15-BlockL1-FA7': 'Spine',
  'BLK-15-BlockL1-FB3': 'Soft tissue',
  'BLK-15-BlockL1-FB8': 'Bone & cartilage',
  // 16 Diseases of the genitourinary system
  'BLK-16-BlockL1-GA0': 'Female genital',
  'BLK-16-BlockL1-GA8': 'Male genital',
  'BLK-16-BlockL1-GB2': 'Breast',
  'BLK-16-BlockL1-GB4': 'Urinary',
  'BLK-16-BlockL1-GC4': 'Other genitourinary',
  // 17 Conditions related to sexual health
  'BLK-17-BlockL1-HA0': 'Sexual dysfunction',
  // 18 Pregnancy, childbirth or the puerperium
  'BLK-18-BlockL1-JA0': 'Pregnancy loss',
  'BLK-18-BlockL1-JA2': 'Hypertension',
  'BLK-18-BlockL1-JA4': 'Haemorrhage',
  'BLK-18-BlockL1-JA6': 'Maternal disorders',
  'BLK-18-BlockL1-JA8': 'Maternal care',
  'BLK-18-BlockL1-JB0': 'Labour & delivery',
  'BLK-18-BlockL1-JB2': 'Delivery',
  'BLK-18-BlockL1-JB4': 'After birth',
  'BLK-18-BlockL1-JB6': 'Other obstetric',
  // 19 Certain conditions originating in the perinatal period
  'BLK-19-BlockL1-KA0': 'Maternal factors',
  'BLK-19-BlockL1-KA2': 'Preterm',
  'BLK-19-BlockL1-KA4': 'Birth injury',
  'BLK-19-BlockL1-KA6': 'Infections',
  'BLK-19-BlockL1-KA8': 'Blood disorders',
  'BLK-19-BlockL1-KB0': 'Nervous',
  'BLK-19-BlockL1-KB2': 'Breathing',
  'BLK-19-BlockL1-KB6': 'Metabolic',
  'BLK-19-BlockL1-KB8': 'Digestive',
  'BLK-19-BlockL1-KC2': 'Skin',
  'BLK-19-BlockL1-KD3': 'Other perinatal',
  // 20 Developmental anomalies
  'BLK-20-BlockL1-LA0': 'One body system',
  'BLK-20-BlockL1-LD2': 'Multiple anomalies',
  'BLK-20-BlockL1-LD4': 'Chromosomal',
  // 22 Injury, poisoning or certain other consequences of external causes
  'BLK-22-BlockL1-NA0': 'Head',
  'BLK-22-BlockL1-NA2': 'Neck',
  'BLK-22-BlockL1-NA8': 'Thorax',
  'BLK-22-BlockL1-NB5': 'Abdomen, pelvis',
  'BLK-22-BlockL1-NC1': 'Shoulder, arm',
  'BLK-22-BlockL1-NC3': 'Elbow, forearm',
  'BLK-22-BlockL1-NC5': 'Wrist, hand',
  'BLK-22-BlockL1-NC7': 'Hip, thigh',
  'BLK-22-BlockL1-NC9': 'Knee, lower leg',
  'BLK-22-BlockL1-ND1': 'Ankle, foot',
  'BLK-22-BlockL1-ND9': 'Burns',
  'BLK-22-BlockL1-NE8': 'Iatrogenic'
});

/** The group of a chapter's small blocks (level2Layout.js `OTHER-<chapter>`). */
export const OTHER_GROUP_LABEL = 'Other';

/**
 * The short name of a block group around a chapter circle.
 *
 * @param {{ id: string, label: string }} group a layout group (its id is the block's concept id)
 */
export function groupShortLabel(group) {
  if (String(group?.id || '').startsWith('OTHER-')) {
    return OTHER_GROUP_LABEL;
  }
  return SHORT_NAMES[group?.id] ?? group?.label ?? '';
}

/** Every authored short name, for the tests. */
export function groupShortNames() {
  return SHORT_NAMES;
}
