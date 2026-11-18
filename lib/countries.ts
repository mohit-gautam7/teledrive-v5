/**
 * Calling codes for the phone sign-in. [ISO code, name, calling code].
 * Codes shared by several countries (+1, +7, +44, +61…) appear once per
 * country so people can find their own name; the number sent is the same.
 */
export const COUNTRIES: [string, string, string][] = [
  ["AF", "Afghanistan", "93"], ["AL", "Albania", "355"], ["DZ", "Algeria", "213"], ["AD", "Andorra", "376"],
  ["AO", "Angola", "244"], ["AG", "Antigua and Barbuda", "1"], ["AR", "Argentina", "54"], ["AM", "Armenia", "374"],
  ["AU", "Australia", "61"], ["AT", "Austria", "43"], ["AZ", "Azerbaijan", "994"], ["BS", "Bahamas", "1"],
  ["BH", "Bahrain", "973"], ["BD", "Bangladesh", "880"], ["BB", "Barbados", "1"], ["BY", "Belarus", "375"],
  ["BE", "Belgium", "32"], ["BZ", "Belize", "501"], ["BJ", "Benin", "229"], ["BT", "Bhutan", "975"],
  ["BO", "Bolivia", "591"], ["BA", "Bosnia and Herzegovina", "387"], ["BW", "Botswana", "267"], ["BR", "Brazil", "55"],
  ["BN", "Brunei", "673"], ["BG", "Bulgaria", "359"], ["BF", "Burkina Faso", "226"], ["BI", "Burundi", "257"],
  ["KH", "Cambodia", "855"], ["CM", "Cameroon", "237"], ["CA", "Canada", "1"], ["CV", "Cape Verde", "238"],
  ["CF", "Central African Republic", "236"], ["TD", "Chad", "235"], ["CL", "Chile", "56"], ["CN", "China", "86"],
  ["CO", "Colombia", "57"], ["KM", "Comoros", "269"], ["CG", "Congo", "242"], ["CD", "Congo (DR)", "243"],
  ["CR", "Costa Rica", "506"], ["CI", "Côte d'Ivoire", "225"], ["HR", "Croatia", "385"], ["CU", "Cuba", "53"],
  ["CY", "Cyprus", "357"], ["CZ", "Czechia", "420"], ["DK", "Denmark", "45"], ["DJ", "Djibouti", "253"],
  ["DM", "Dominica", "1"], ["DO", "Dominican Republic", "1"], ["EC", "Ecuador", "593"], ["EG", "Egypt", "20"],
  ["SV", "El Salvador", "503"], ["GQ", "Equatorial Guinea", "240"], ["ER", "Eritrea", "291"], ["EE", "Estonia", "372"],
  ["SZ", "Eswatini", "268"], ["ET", "Ethiopia", "251"], ["FJ", "Fiji", "679"], ["FI", "Finland", "358"],
  ["FR", "France", "33"], ["GA", "Gabon", "241"], ["GM", "Gambia", "220"], ["GE", "Georgia", "995"],
  ["DE", "Germany", "49"], ["GH", "Ghana", "233"], ["GR", "Greece", "30"], ["GD", "Grenada", "1"],
  ["GT", "Guatemala", "502"], ["GN", "Guinea", "224"], ["GW", "Guinea-Bissau", "245"], ["GY", "Guyana", "592"],
  ["HT", "Haiti", "509"], ["HN", "Honduras", "504"], ["HK", "Hong Kong", "852"], ["HU", "Hungary", "36"],
  ["IS", "Iceland", "354"], ["IN", "India", "91"], ["ID", "Indonesia", "62"], ["IR", "Iran", "98"],
  ["IQ", "Iraq", "964"], ["IE", "Ireland", "353"], ["IL", "Israel", "972"], ["IT", "Italy", "39"],
  ["JM", "Jamaica", "1"], ["JP", "Japan", "81"], ["JO", "Jordan", "962"], ["KZ", "Kazakhstan", "7"],
  ["KE", "Kenya", "254"], ["KI", "Kiribati", "686"], ["KW", "Kuwait", "965"], ["KG", "Kyrgyzstan", "996"],
  ["LA", "Laos", "856"], ["LV", "Latvia", "371"], ["LB", "Lebanon", "961"], ["LS", "Lesotho", "266"],
  ["LR", "Liberia", "231"], ["LY", "Libya", "218"], ["LI", "Liechtenstein", "423"], ["LT", "Lithuania", "370"],
  ["LU", "Luxembourg", "352"], ["MO", "Macau", "853"], ["MG", "Madagascar", "261"], ["MW", "Malawi", "265"],
  ["MY", "Malaysia", "60"], ["MV", "Maldives", "960"], ["ML", "Mali", "223"], ["MT", "Malta", "356"],
  ["MH", "Marshall Islands", "692"], ["MR", "Mauritania", "222"], ["MU", "Mauritius", "230"], ["MX", "Mexico", "52"],
  ["FM", "Micronesia", "691"], ["MD", "Moldova", "373"], ["MC", "Monaco", "377"], ["MN", "Mongolia", "976"],
  ["ME", "Montenegro", "382"], ["MA", "Morocco", "212"], ["MZ", "Mozambique", "258"], ["MM", "Myanmar", "95"],
  ["NA", "Namibia", "264"], ["NR", "Nauru", "674"], ["NP", "Nepal", "977"], ["NL", "Netherlands", "31"],
  ["NZ", "New Zealand", "64"], ["NI", "Nicaragua", "505"], ["NE", "Niger", "227"], ["NG", "Nigeria", "234"],
  ["KP", "North Korea", "850"], ["MK", "North Macedonia", "389"], ["NO", "Norway", "47"], ["OM", "Oman", "968"],
  ["PK", "Pakistan", "92"], ["PW", "Palau", "680"], ["PS", "Palestine", "970"], ["PA", "Panama", "507"],
  ["PG", "Papua New Guinea", "675"], ["PY", "Paraguay", "595"], ["PE", "Peru", "51"], ["PH", "Philippines", "63"],
  ["PL", "Poland", "48"], ["PT", "Portugal", "351"], ["PR", "Puerto Rico", "1"], ["QA", "Qatar", "974"],
  ["RO", "Romania", "40"], ["RU", "Russia", "7"], ["RW", "Rwanda", "250"], ["KN", "Saint Kitts and Nevis", "1"],
  ["LC", "Saint Lucia", "1"], ["VC", "Saint Vincent and the Grenadines", "1"], ["WS", "Samoa", "685"], ["SM", "San Marino", "378"],
  ["ST", "São Tomé and Príncipe", "239"], ["SA", "Saudi Arabia", "966"], ["SN", "Senegal", "221"], ["RS", "Serbia", "381"],
  ["SC", "Seychelles", "248"], ["SL", "Sierra Leone", "232"], ["SG", "Singapore", "65"], ["SK", "Slovakia", "421"],
  ["SI", "Slovenia", "386"], ["SB", "Solomon Islands", "677"], ["SO", "Somalia", "252"], ["ZA", "South Africa", "27"],
  ["KR", "South Korea", "82"], ["SS", "South Sudan", "211"], ["ES", "Spain", "34"], ["LK", "Sri Lanka", "94"],
  ["SD", "Sudan", "249"], ["SR", "Suriname", "597"], ["SE", "Sweden", "46"], ["CH", "Switzerland", "41"],
  ["SY", "Syria", "963"], ["TW", "Taiwan", "886"], ["TJ", "Tajikistan", "992"], ["TZ", "Tanzania", "255"],
  ["TH", "Thailand", "66"], ["TL", "Timor-Leste", "670"], ["TG", "Togo", "228"], ["TO", "Tonga", "676"],
  ["TT", "Trinidad and Tobago", "1"], ["TN", "Tunisia", "216"], ["TR", "Türkiye", "90"], ["TM", "Turkmenistan", "993"],
  ["TV", "Tuvalu", "688"], ["UG", "Uganda", "256"], ["UA", "Ukraine", "380"], ["AE", "United Arab Emirates", "971"],
  ["GB", "United Kingdom", "44"], ["US", "United States", "1"], ["UY", "Uruguay", "598"], ["UZ", "Uzbekistan", "998"],
  ["VU", "Vanuatu", "678"], ["VE", "Venezuela", "58"], ["VN", "Vietnam", "84"], ["YE", "Yemen", "967"],
  ["ZM", "Zambia", "260"], ["ZW", "Zimbabwe", "263"]
];

export const DEFAULT_COUNTRY = "IN";

/** 🇮🇳 from "IN". */
export const flag = (iso: string) => String.fromCodePoint(...[...iso].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));

/**
 * The full international number for what was typed under `iso`.
 *
 * A number typed with its own "+" wins over the dropdown. A leading trunk 0
 * (098…, 07…) is dropped, since people often type it — except for Italy,
 * where it is part of the number.
 */
export function fullNumber(iso: string, typed: string): string {
  const raw = typed.trim();
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return digits ? `+${digits}` : "";
  const dial = COUNTRIES.find(c => c[0] === iso)?.[2] ?? "91";
  const national = dial === "39" ? digits : digits.replace(/^0+/, "");
  return national ? `+${dial}${national}` : "";
}

/** For codes shared by several countries, the one a bare "+code" most likely means. */
const MAIN: Record<string, string> = { "1": "US", "7": "RU", "44": "GB", "61": "AU" };

/** The country a "+…" number belongs to (longest matching code), if any. */
export function countryForNumber(typed: string): string | null {
  const digits = typed.trim().startsWith("+") ? typed.replace(/\D/g, "") : "";
  if (!digits) return null;
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (MAIN[code]) return MAIN[code];
    const hit = COUNTRIES.find(c => c[2] === code);
    if (hit) return hit[0];
  }
  return null;
}
