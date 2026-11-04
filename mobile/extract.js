// Port of scanlog/extract.py — keep the two in sync (tests/parity check compares them).
// Pulls incident type, location, units, 10-codes and status out of one transcript.

export const INCIDENT_TYPES = [
  ["violent", "Shooting", 1, [String.raw`shots? fired`, String.raw`(?:person|male|female|subject|victim|someone) (?:has been |was |been )?shot`, String.raw`\bshooting\b`, String.raw`gunshot wound`, String.raw`\bGSW\b`, String.raw`shot spotter|shotspotter`]],
  ["violent", "Stabbing", 1, [String.raw`stab(?:bed|bing)`, String.raw`cut with a knife`]],
  ["violent", "Armed person", 1, [String.raw`(?:man|male|subject|person|suspect) with a (?:gun|weapon|knife)`, String.raw`armed (?:party|subject|suspect)`, String.raw`brandish`]],
  ["violent", "Homicide / DOA", 1, [String.raw`homicide`, String.raw`\bDOA\b`, String.raw`deceased (?:person|male|female)`, String.raw`signal 7\b`]],
  ["violent", "Robbery", 2, [String.raw`(?:armed |strong[- ]arm(?:ed)? )?robbery`, String.raw`car ?jack`, String.raw`hold[- ]?up`]],
  ["violent", "Assault", 2, [String.raw`aggravated assault`, String.raw`\bassault`, String.raw`fight(?:ing)? in progress`, String.raw`\bfight\b`, String.raw`beat(?:en|ing) up`]],
  ["violent", "Domestic", 2, [String.raw`domestic(?: violence| disturbance| dispute)?`]],
  ["fire", "Structure fire", 1, [String.raw`(?:structure|house|residential|commercial|apartment|building|working|garage) fire`, String.raw`smoke (?:and fire )?(?:showing|from the (?:roof|eaves|building))`, String.raw`fire showing`, String.raw`flames showing`, String.raw`fully involved`]],
  ["fire", "Vehicle fire", 2, [String.raw`(?:vehicle|car|truck|auto) fire`, String.raw`car on fire`, String.raw`vehicle on fire`]],
  ["fire", "Outside / brush fire", 3, [String.raw`(?:brush|grass|trash|dumpster|outside|woods) fire`]],
  ["fire", "Gas leak / hazmat", 2, [String.raw`gas leak`, String.raw`odor of (?:natural )?gas`, String.raw`smell of gas`, String.raw`hazmat`, String.raw`chemical spill`, String.raw`carbon monoxide|\bCO alarm`]],
  ["fire", "Fire alarm", 4, [String.raw`fire alarm`, String.raw`alarm sounding`, String.raw`smoke detector`]],
  ["fire", "Rescue", 1, [String.raw`water rescue`, String.raw`entrap(?:ment|ped)`, String.raw`trapped`, String.raw`pinned`, String.raw`extrication`, String.raw`elevator rescue`, String.raw`high angle`]],
  ["ems", "Cardiac arrest", 1, [String.raw`cardiac arrest`, String.raw`\bCPR\b`, String.raw`not breathing`, String.raw`no pulse`, String.raw`full arrest`, String.raw`code blue`]],
  ["ems", "Overdose", 2, [String.raw`overdose`, String.raw`\bOD\b`, String.raw`narcan`]],
  ["ems", "Unresponsive", 2, [String.raw`unresponsive`, String.raw`unconscious`, String.raw`passed out`]],
  ["ems", "Breathing problem", 2, [String.raw`difficulty breathing`, String.raw`trouble breathing`, String.raw`short(?:ness)? of breath`, String.raw`respiratory distress`, String.raw`choking`]],
  ["ems", "Chest pain", 2, [String.raw`chest pain`]],
  ["ems", "Stroke", 2, [String.raw`\bstroke\b`, String.raw`\bCVA\b`]],
  ["ems", "Seizure", 3, [String.raw`seizur(?:e|ing)`]],
  ["ems", "Fall / injury", 3, [String.raw`\bfall(?:en)?\b(?: victim)?`, String.raw`fell`, String.raw`laceration`, String.raw`injur(?:y|ed) person`]],
  ["ems", "Medical call", 4, [String.raw`sick (?:person|call|case)`, String.raw`diabetic`, String.raw`pregnan|\bOB\b|in labor`, String.raw`medical (?:call|emergency)`, String.raw`allergic reaction`, String.raw`abdominal pain`, String.raw`psych(?:iatric)?`]],
  ["traffic", "Crash w/ injuries", 1, [String.raw`pedestrian (?:struck|hit)`, String.raw`(?:auto|vehicle)[- ]pedestrian`, String.raw`rollover`, String.raw`(?:accident|crash|wreck|MVA) with (?:injur|entrap)`, String.raw`head[- ]on`, String.raw`motorcycle (?:accident|crash|down)`]],
  ["traffic", "Crash", 3, [String.raw`\bMVA\b`, String.raw`motor vehicle (?:accident|crash|collision)`, String.raw`\b(?:car |auto |vehicle |traffic )?(?:accident|crash|wreck)\b`, String.raw`10[- ]50\b`, String.raw`hit and run`]],
  ["traffic", "Pursuit", 1, [String.raw`pursuit`, String.raw`(?:in a |vehicle )chase`, String.raw`fleeing in (?:a|the) vehicle`, String.raw`failed to stop`, String.raw`(?:vehicle|car) (?:fled|fleeing)`]],
  ["traffic", "Traffic hazard", 4, [String.raw`(?:debris|obstruction|disabled vehicle|stalled vehicle) in the road`, String.raw`traffic (?:hazard|light out|signal out)`, String.raw`wrong[- ]way driver`, String.raw`road (?:blocked|closed)`]],
  ["property", "Burglary", 3, [String.raw`burglary`, String.raw`break[- ]?in`, String.raw`broke into`, String.raw`breaking into`, String.raw`forced entry`]],
  ["property", "Theft / stolen vehicle", 4, [String.raw`stolen (?:vehicle|car|auto|truck)`, String.raw`\btheft\b`, String.raw`shoplift`, String.raw`stole`, String.raw`larceny`, String.raw`catalytic converter`]],
  ["property", "Vandalism", 4, [String.raw`vandal`, String.raw`criminal mischief`, String.raw`graffiti`, String.raw`windows? (?:broken|busted)`]],
  ["property", "Alarm", 5, [String.raw`(?:burglar|intrusion|panic|business|residential) alarm`, String.raw`alarm call`]],
  ["other", "Foot pursuit", 1, [String.raw`foot pursuit`, String.raw`(?:fled|fleeing|running|took off) on foot`, String.raw`on foot running`, String.raw`running from (?:officers|police)`, String.raw`\bbailed\b`, String.raw`\bfled\b`]],
  ["other", "Officer needs help", 1, [String.raw`officer (?:down|needs (?:help|assistance))`, String.raw`(?:need|send) (?:more )?(?:cars|units|backup) (?:now|asap|code)`, String.raw`10[- ]33\b`, String.raw`\bmayday\b`, String.raw`emergency button`]],
  ["other", "Missing person", 3, [String.raw`missing (?:person|child|juvenile|elderly)`, String.raw`runaway`, String.raw`silver alert|amber alert|endangered child`]],
  ["other", "Suspicious", 4, [String.raw`suspicious (?:person|vehicle|activity|party|male|female|car)`, String.raw`prowler`]],
  ["other", "Disturbance", 4, [String.raw`disturbance`, String.raw`loud (?:music|party)`, String.raw`noise complaint`, String.raw`intoxicated`, String.raw`disorderly`, String.raw`trespass`]],
  ["other", "Welfare check", 4, [String.raw`welfare (?:check|concern)`, String.raw`check (?:on )?the welfare`]],
];
const COMPILED = INCIDENT_TYPES.map(([c, l, p, pats]) => [c, l, p, pats.map(x => new RegExp(x, "i"))]);
export const CATEGORY_OF = Object.fromEntries(INCIDENT_TYPES.map(([c, l, p]) => [l, { category: c, priority: p }]));

export const TEN_CODES = {
  "10-4": "acknowledged", "10-6": "busy", "10-7": "out of service", "10-8": "in service", "10-9": "repeat",
  "10-10": "negative", "10-19": "return to station", "10-20": "location", "10-22": "disregard", "10-23": "arrived on scene",
  "10-27": "license check", "10-28": "registration check", "10-29": "warrant check", "10-32": "person with gun",
  "10-33": "emergency", "10-50": "vehicle accident", "10-52": "ambulance needed", "10-76": "en route", "10-97": "on scene",
  "10-98": "assignment complete",
};
const CODE_RE = /\b10[- ]?(\d{1,3})\b/gi;

export const STATUS_ORDER = ["dispatched", "en_route", "on_scene", "transporting", "cleared"];
const STATUS_PATTERNS = [
  ["dispatched", /\b(?:respond(?:ing)?|dispatch(?:ed|ing)?|(?:make|start) (?:your way|that way)|need (?:a|an|the) (?:car|unit|engine|medic))\b/i],
  ["en_route", /\b(?:en ?route|responding|on (?:the|my|our) way|10[- ]?76)\b/i],
  ["on_scene", /\b(?:on scene|on location|arriv(?:ed|ing)|at the location|10[- ]?(?:23|97))\b/i],
  ["transporting", /\b(?:transport(?:ing)?|en route to (?:the )?(?:hospital|regional|methodist|baptist|st\.? francis|le bonheur|med)|to the med)\b/i],
  ["cleared", /\b(?:clear(?:ing)?(?: the scene)?|back in service|in service|available|10[- ]?(?:8|98)|cancel(?:led)?|disregard|10[- ]?22|under control|knock(?:ed)? down|all out)\b/i],
];

const UNIT_RE = /\b(Engine|Ladder|Truck|Tower|Medic|Rescue|Ambulance|Squad|Battalion(?: Chief)?|District Chief|Brush|Tanker|Hazmat|Air|Car|Unit|Sector|Command|Wings)\s?(\d{1,4})\b/gi;

const SUFFIX = String.raw`(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Parkway|Pkwy|Lane|Ln|Cove|Cv|Place|Pl|Circle|Cir|Way|Court|Ct|Highway|Hwy|Pike|Trail|Trl|Terrace|Ter|Expressway|Expy|Loop|Plaza|Square|Run|Path)`;
const DIRECTION = String.raw`(?:North|South|East|West|N|S|E|W)\.?`;
const NUMWORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

export const KNOWN_STREETS = [
  "Poplar", "Union", "Madison", "Jefferson", "Adams", "Monroe", "Lamar", "Elvis Presley", "Getwell", "Winchester",
  "Shelby Drive", "Summer", "Jackson", "Austin Peay", "Covington Pike", "Germantown Parkway", "Germantown Road",
  "Kirby", "Ridgeway", "Mendenhall", "Perkins", "Highland", "Park", "Airways", "Millbranch", "Third", "Front",
  "Riverside", "Main", "Walnut Grove", "Sam Cooper", "Macon", "Raleigh LaGrange", "Stage", "Frayser", "Watkins",
  "Hollywood", "Chelsea", "Thomas", "Danny Thomas", "Crump", "Cooper", "McLean", "Belvedere", "Quince",
  "Knight Arnold", "American Way", "Tchulahoma", "Holmes", "Hacks Cross", "Riverdale", "Goodman", "Brooks",
  "Raines", "Mallory", "Horn Lake", "Ford", "Mitchell", "Levi", "Southern", "Central", "Lauderdale", "Bellevue",
  "Dunlap", "Manassas", "Vance", "Linden", "Beale", "Peabody", "Trigg", "South Parkway", "East Parkway",
  "North Parkway", "Broad", "Sycamore View", "Whitten", "Appling", "Houston Levee", "Collierville Arlington",
  "Byhalia", "Forest Hill Irene", "Bill Morris", "Nonconnah", "Lamar Avenue", "Interstate 40", "Interstate 240",
  "Interstate 55", "Interstate 269", "I-40", "I-240", "I-55", "I-269", "Highway 51", "Highway 70", "Highway 64",
  "Highway 385", "Navy", "Singleton", "Kerr", "Shelby Oaks", "Elmore", "Yale", "Old Allen", "Jackson Avenue",
  "Wolfchase", "Players Club", "Ross", "Hickory Hill", "Clarke", "Sanderlin", "White Station", "Mt Moriah",
  "Mount Moriah", "Wells Station", "Graham", "Tillman", "Semmes", "Prescott", "Castalia", "Kimball", "Pendleton",
  "Rozelle", "McKellar", "Ketchum", "Hunter", "Hamilton", "Neely", "Weaver", "Fairway", "Westmont", "Norris",
  "Corning", "Hawkins Mill", "Benjestown", "Thomas Street", "Chelsea Avenue", "St Elmo", "Stateline", "Riverdale",
];
// Common speech-recognition mishearings of local names (applied before extraction)
export const CORRECTIONS = [
  [/\bget ?well\b/gi, "Getwell"], [/\belvis pres+le?y\b/gi, "Elvis Presley"], [/\bpop(?:p)?ler\b/gi, "Poplar"],
  [/\btchula ?homa|chula ?homa\b/gi, "Tchulahoma"], [/\bhacks? cross\b/gi, "Hacks Cross"], [/\baustin p(?:ea|e)y\b/gi, "Austin Peay"],
  [/\bmilbranch|mill branch\b/gi, "Millbranch"], [/\bmendin ?hall\b/gi, "Mendenhall"], [/\bmedic(?:k)?\s+(\d)/gi, "Medic $1"],
];

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KNOWN_ALT = [...new Set(KNOWN_STREETS)].sort((a, b) => b.length - a.length)
  .map(s => escRe(s).replace(/ /g, String.raw`[\s-]`)).join("|");
const STREET_NAME = String.raw`(?:${DIRECTION}\s+)?(?:(?:${KNOWN_ALT})(?:\s+${SUFFIX})?|(?:[A-Z][a-zA-Z']+\s+){0,3}?[A-Z][a-zA-Z']+\s+${SUFFIX})`;
const ADDRESS_RE = new RegExp(String.raw`\b(\d{1,6}[A-Z]?)\s+(?:block\s+(?:of\s+)?)?(${STREET_NAME})\b`, "i");
const HUNDRED_BLOCK_RE = new RegExp(String.raw`\b(\d{1,3})\s+hundred\s+block\s+(?:of\s+)?(${STREET_NAME})\b`, "i");
const INTERSECTION_RE = new RegExp(String.raw`\b(${STREET_NAME})\s+(?:and|at|&|near|by)\s+(${STREET_NAME})\b`, "i");
const LANDMARK_RE = new RegExp(String.raw`\b(?:at|in front of|behind|outside(?: of)?|in the parking lot of|toward(?:s)?|towards)\s+(?:the\s+)?` +
  String.raw`((?:[A-Z][\w'&]+\s){0,4}(?:Walmart|Kroger|Mall|Hospital|School|High School|Elementary|Apartments|` +
  String.raw`Church|Park|Gas Station|Shell|Exxon|Circle K|Mapco|Dollar General|Family Dollar|Walgreens|CVS|` +
  String.raw`Motel|Hotel|Inn|Stadium|Arena|Forum|Airport|Library|Plaza|Center|Centre))\b` +
  String.raw`(?:\s+(?:on|at|off(?: of)?)\s+(${STREET_NAME}))?`, "i");

const PLATE_RE = /\b(?:tag|plate)(?: number)?\s+(?:is\s+)?([A-Z0-9]{2,4}[\s-]?[A-Z0-9]{2,4})\b/gi;
const DOB_RE = /\b(?:date of birth|d\.?o\.?b\.?|born)\s*(?:of|is)?\s*[:\-]?\s*(\d{1,2}[\s/\-.]\d{1,2}[\s/\-.]\d{2,4}|\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}|\d{6,8})/gi;
const SSN_RE = /\b\d{3}[\s-]\d{2}[\s-]\d{4}\b/g;

export function correct(text) {
  for (const [re, rep] of CORRECTIONS) text = text.replace(re, rep);
  return text;
}

export function redact(text, privacy = {}) {
  if (privacy.redact_dob !== false) text = text.replace(DOB_RE, (m, g) => m.replace(g, "[DOB]"));
  if (privacy.redact_ssn !== false) text = text.replace(SSN_RE, "[SSN]");
  if (privacy.redact_plates) text = text.replace(PLATE_RE, (m, g) => m.replace(g, "[PLATE]"));
  return text;
}

function wordsToNumbers(text) {
  const w = Object.keys(NUMWORDS).join("|");
  return text.replace(new RegExp(String.raw`\b(${w})(?:[\s-](${w}))?\s+hundred\s+block`, "gi"),
    (_, a, b) => `${((NUMWORDS[a.toLowerCase()] || 0) + (NUMWORDS[(b || "").toLowerCase()] || 0)) * 100} block`);
}

function cleanStreet(s) {
  s = s.trim().replace(/^[ ,.]+|[ ,.]+$/g, "").replace(/\s+/g, " ").trim();
  return s.split(" ").map(w => (w === w.toUpperCase() && w.length <= 3) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

export function normalizeAddress(addr) {
  if (!addr) return null;
  let a = addr.toLowerCase();
  const repl = [[/\bstreet\b/g, "st"], [/\bavenue\b/g, "ave"], [/\broad\b/g, "rd"], [/\bdrive\b/g, "dr"], [/\bboulevard\b/g, "blvd"],
    [/\bparkway\b/g, "pkwy"], [/\blane\b/g, "ln"], [/\bcove\b/g, "cv"], [/\bplace\b/g, "pl"], [/\bcircle\b/g, "cir"], [/\bcourt\b/g, "ct"],
    [/\bhighway\b/g, "hwy"], [/\bnorth\b/g, "n"], [/\bsouth\b/g, "s"], [/\beast\b/g, "e"], [/\bwest\b/g, "w"], [/\bmount\b/g, "mt"],
    [/[.,]/g, ""], [/\s+/g, " "]];
  for (const [k, v] of repl) a = a.replace(k, v);
  a = a.trim();
  if (a.includes(" & ")) a = a.split(" & ").map(p => p.trim()).sort().join(" & ");
  const m = a.match(/^(\d+)\s+(?:block\s+)?(.*)$/);
  if (m) a = `${Math.floor(parseInt(m[1].replace(/\D/g, "") || "0", 10) / 100) * 100} ${m[2]}`;
  return a;
}

function looksLikeUnitNumber(text, idx) {
  const before = text.slice(Math.max(0, idx - 14), idx);
  return /(?:Engine|Ladder|Truck|Medic|Rescue|Squad|Battalion|Unit|Car|Station|Sector|channel|code)\s*$/i.test(before);
}

export function extract(text) {
  const ex = { category: null, incident_type: null, priority: 9, address: null, address_kind: null, units: [], codes: [], status: null, keywords: [] };
  if (!text) return ex;
  const t = wordsToNumbers(text);

  let best = null;
  for (const [cat, label, prio, pats] of COMPILED) {
    for (const p of pats) {
      const m = p.exec(t);
      if (m) {
        if (!best || prio < best[0] || (prio === best[0] && m.index < best[1])) best = [prio, m.index, cat, label];
        ex.keywords.push(m[0].toLowerCase());
        break;
      }
    }
  }
  if (best) [ex.priority, , ex.category, ex.incident_type] = best;

  const hb = HUNDRED_BLOCK_RE.exec(t);
  const a = ADDRESS_RE.exec(t);
  if (a && !looksLikeUnitNumber(t, a.index)) {
    const kind = /block/i.test(a[0]) ? "block" : "address";
    ex.address = `${a[1]} ${kind === "block" ? "block " : ""}${cleanStreet(a[2])}`; ex.address_kind = kind;
  } else if (hb) {
    ex.address = `${parseInt(hb[1], 10) * 100} block ${cleanStreet(hb[2])}`; ex.address_kind = "block";
  } else {
    const i = INTERSECTION_RE.exec(t);
    if (i && cleanStreet(i[1]).toLowerCase() !== cleanStreet(i[2]).toLowerCase()) {
      ex.address = `${cleanStreet(i[1])} & ${cleanStreet(i[2])}`; ex.address_kind = "intersection";
    } else {
      const lm = LANDMARK_RE.exec(t);
      if (lm) {
        ex.address = lm[1].trim() + (lm[2] ? ` on ${cleanStreet(lm[2])}` : ""); ex.address_kind = "landmark";
      }
    }
  }

  for (const m of t.matchAll(UNIT_RE)) {
    const u = `${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase().replace(/ (\w)/g, (_, c) => " " + c.toUpperCase())} ${parseInt(m[2], 10)}`;
    if (!ex.units.includes(u)) ex.units.push(u);
  }
  for (const m of t.matchAll(CODE_RE)) {
    const code = `10-${m[1]}`;
    if (TEN_CODES[code] && !ex.codes.includes(code)) ex.codes.push(code);
  }
  const found = STATUS_PATTERNS.filter(([, p]) => p.test(t)).map(([n]) => n);
  if (found.length) ex.status = found.reduce((x, y) => (STATUS_ORDER.indexOf(y) > STATUS_ORDER.indexOf(x) ? y : x));
  return ex;
}
