import type { DictionaryEntry } from '../../shared/types';

/**
 * Staggered physical QWERTY key coordinates (x in key widths, y in rows).
 * Used to weight substitutions and adjacent fat-finger insertions.
 */
const QWERTY_COORDS: Record<string, readonly [number, number]> = {
  q: [0, 0],
  w: [1, 0],
  e: [2, 0],
  r: [3, 0],
  t: [4, 0],
  y: [5, 0],
  u: [6, 0],
  i: [7, 0],
  o: [8, 0],
  p: [9, 0],
  a: [0.25, 1],
  s: [1.25, 1],
  d: [2.25, 1],
  f: [3.25, 1],
  g: [4.25, 1],
  h: [5.25, 1],
  j: [6.25, 1],
  k: [7.25, 1],
  l: [8.25, 1],
  z: [0.75, 2],
  x: [1.75, 2],
  c: [2.75, 2],
  v: [3.75, 2],
  b: [4.75, 2],
  n: [5.75, 2],
  m: [6.75, 2],
};

/**
 * Curated ~2,200+ common English + developer/tech words ordered roughly from
 * highest frequency to lower frequency. Lower rank index breaks ties in favor
 * of more common words.
 */
const COMMON_WORDS_RAW = `
the be to of and a in that have i it for not on with he as you do at
this but his by from they we say her she or an will my one all would there their what
so up out if about who get which go me when make can like time no just him know take
people into year your good some could them see other than then now look only come its over
think also back after use two how our work first well way even new want because any these
give day most us are is was were been being had has did does doing made got went came said
told asked thought felt knew seen found gave took brought kept held stood let put set meant
left turned started began tried needed wanted seemed looked called used worked lived moved
i'm i've i'll i'd it's that's what's who's where's when's why's how's there's here's
don't doesn't didn't won't wouldn't can't couldn't shouldn't isn't aren't wasn't weren't
haven't hasn't hadn't mustn't needn't let's you're they're we're he's she's you've they've
we've you'll they'll we'll you'd they'd we'd he'll she'll he'd she'd
very much more many such every each both few little own same another old big high small
large long short young right wrong true false real full empty hard easy fast slow early late
next last first second third best better worst worse bad great nice fine cool okay ok
sure clear ready able free open close near far low top bottom side front end start
point line part place case week month year hour minute second today tomorrow tonight
yesterday morning afternoon evening night home house room door table chair bed car road
street city town world country state area water food coffee tea milk bread fruit
man men woman women child children boy girl friend family mother father brother sister
person name word words text message msg note notes letter letters book books page pages
story idea ideas question questions answer answers problem problems solution solutions
reason reasons fact facts truth thing things stuff way ways life hand hands head eye eyes
face voice mind heart body air light sound color music song game play team group
company business job office school class student teacher doctor money price cost value
number numbers amount level rate order type kind form sort list item items part parts
system systems process step steps plan plans project projects task tasks goal goals
rule rules law power control force energy heat fire wind rain snow sun moon sky
tree trees dog cat bird fish animal food
about above across actually add added adding address after again against ago agree agreed
air all almost alone along already also although always among amount an and another answer
any anyone anything anywhere appear appeared appears apply applied applies area around
arrive arrived ask asked asking assume assumed attach attached attack attempt attend
available avoid aware away back bad bag ball band bank bar base based basic basically
basis be bear beat became become becomes becoming bed been before began begin beginning
begins begun behind believe believed below beneath beside best better between beyond
big bill bit black block blood blue board boat body book born both bottom box boy branch
break bring broad broke broken brother brought brown build building built burn bus
business busy but buy buying by call called calling calls calm came camera camp can cancel
cannot cap car card care career careful carefully carry case cat catch caught cause
caused causes cell center central century certain certainly chain chair chance change
changed changes changing channel character charge check checked checking checks choice
choose chose chosen church circle city claim class clean clear clearly client climb
clock close closed closely closer closes closing cloud club coach coat code coffee cold
collect collection college color combine come comes coming command comment commit
common community company compare compared complete completely complex computer concept
concern concerned condition conduct confirm connect connected connection consider
considered consist contact contain contained contains content continue continued continues
control copy corner correct cost could count counter country couple course court cover
covered create created creates creating creation credit crew crime cross crowd cry
cultural culture cup current currently custom customer cut cycle daily damage dance danger
dark data date daughter day dead deal dealing dear death debate decade decide decided
decision deep deeply default defense define defined definitely degree delay delete
deleted deliver delivery demand depend depends describe described description design
designed designer desire desk detail details determine developed developer development
device devices die died difference different differently difficult difficulty dinner direct
direction directly director dirt dirty disappear discover discuss discussed discussion
discussions disease dish disk display distance distribute divide doctor document does
doesn't doing dollar domain done door double doubt down draft drag draw drawing dream
dress drink drive driver drop dropped drug dry due during dust duty each ear early earn
earth ease easily east easy eat eating edge edit edited editing editor educate education
effect effective effectively effort egg eight either elbow elect election electric
element else email emerge emotion emphasis employ employee empty enable enabled end
ended ending ends enemy energy enforce engage engine engineer enjoy enough ensure enter
entered entire entirely entry environment equal equally equipment error errors escape
especially essential establish estate estimate etc even evening event events eventually
ever every everybody everyone everything everywhere evidence exact exactly exam examine
example examples exceed excellent except exchange excite excited exciting exclude excuse
execute exercise exist existed existence existing exists expand expect expected
expecting expense expensive experience experienced experiment expert explain explained
explaining explains explanation explore export expose express extend extension extent
extra extreme extremely eye eyes face fact factor fail failed failing fails failure fair
fairly fall fallen falling falls false familiar family famous fan fancy far farm fast
faster fastest fat father fault favor favorite fear feature features federal feed
feedback feel feeling feels feet fell fellow felt female fence few field fight figure
file files fill filled film final finally finance financial find finding finds fine
finger finish finished fire firm first fish fit five fix fixed fixes fixing flag flat
flight float floor flow flower fly focus fold follow followed following follows food foot
football for force forced forces foreign forest forever forget forgot forgotten form
formal format former forth forward found foundation four frame framework free freedom
frequently fresh friend friendly friends from front fruit fuel full fully fun function
functions fund fundamental funds funny furniture further future gain game games gap
garage garden gas gate gather gave gear general generally generate generated generation
gentleman get gets getting giant gift girl give given gives giving glad glass global
glove go goal god goes going gold gone good goods got gotten grab grade grain grand
grant grass grateful grave gray great greater greatest greatly green grew ground group
groups grow growing grown growth guard guess guessed guesses guessing guest guide
guilty gun guy habit had hair half hall hand handle handled hands hang happen happened
happening happens happy hard hardly harm hat hate have having he head health healthy
hear heard hearing heart heat heavy height held hell hello help helped helpful helping
helps her here hers herself hi hide high higher highly hill him himself hire his history
hit hold holder holding holds hole holiday home honest honey honor hope hoped hopefully
hopes hoping horse hospital hot hotel hour hours house housing how however huge human
humor hundred hung hunger hunt hurry hurt husband ice idea ideal ideas identify identity
if ignore ignored ill illegal illness image imagine immediate immediately impact
implement implemented imply import importance important impose impossible impress
impression improve improved improvement in inch incident include included includes
including income increase increased increasing indeed independent index indicate
indicated individual industry influence inform information initial initially initiative
injury inner innocent input inquiry inside insist inspect inspire install installed
instance instead instinct institute instruction instrument insurance integrate intend
intended intense intent intention interact interest interested interesting internal
international internet interpret interval interview into introduce introduced
introduction invest investigate investment invite invited involve involved involvement
iron is island issue issued issues it item items its itself jacket jail jam jar job
jobs join joined joining joint joke journal journey joy judge judgment jump jumped
junior jury just justice justify keep keeping keeps kept key keyboard keyboards keys
kick kid kids kill killed kind kindly king kiss kitchen knee knew knife knock know
knowing knowledge known knows lab label labor lack lady laid lake land landing landscape
language large largely last late lately later latest laugh launched law lawyer lay layer
lead leader leadership leading leads leaf league lean learn learned learning least
leather leave leaves leaving led left leg legal legend lemon lend length less lesson
let lets letter letters level library license lie life lift light like liked likely
likes limit limited line lines link linked links lip liquid list listen listened
listening lists literally literature little live lived lives living load loaded loading
loan local locate location lock locked log logic logical lone long longer look looked
looking looks loop loose lose losing loss lost lot lots loud love loved lovely lover
loves low lower luck lucky lunch machine mad made magazine magic mail main mainly
maintain maintained major majority make maker makers makes making male mall man manage
managed management manager manner manufacture many map march margin mark marked market
marketing marriage marry mass massive master match matched matches material math matter
matters may maybe mayor me meal mean meaning means meant meanwhile measure measurement
meat mechanism media medical medicine medium meet meeting meets member members memory
mental mention mentioned menu mere merely mess message messages met metal method
methods middle might mile military milk million mind mine mineral minimal minimize
minimum minor minority minute minutes mirror miss missed missing mission mistake
mistakes mix mixed mixture mobile mode model models moderate modern modest module
modules moment moments money monitor month months mood moon moral more moreover morning
mortgage most mostly mother motion motivate motor mount mountain mouse mouth move
moved movement moves movie moving mr mrs ms much mud multiple murder muscle museum music
must mutual my myself mystery myth nail name named names narrow nation national native
natural naturally nature near nearby nearly neat necessary neck need needed needing
needs negative neglect neighbor neighborhood neither nerve nervous nest net network
never nevertheless new newly news newspaper next nice night nine no nobody nod noise
none nonetheless nor normal normally north nose not note noted notes nothing notice
noticed notion novel now nowhere nuclear number numbers numerous nurse nut object
objects objective obligation observe obtain obvious obviously occasion occasional
occasionally occupy occur occurred occurring occurs ocean odd odds of off offend
offer offered offering offers office officer official often oh oil ok okay old older
on once one ones online only onto open opened opening opens operate operating operation
operator opinion opponent opportunity oppose opposite option options or orange order
ordered orders ordinary organ organization organize organized origin original originally
other others otherwise ought our ours ourselves out outcome outdoor outer outline
output outside outstanding over overall overcome overlook owe own owned owner owners
ownership pace pack package packages packed page pages paid pain paint pair pale pan
panel panic paper parent parents park parking part partial partially participate
particular particularly partly partner partners party pass passed passes passing
passion past path paths patient pattern pause pay paying payment peace peak pen penalty
people pepper per perceive percent percentage perception perfect perfectly perform
performance perhaps period permanent permission permit person personal personality
personally perspective persuade pet phase phenomenon philosophy phone photo photograph
phrase physical physically piano pick picked picking picture pictures pie piece pieces
pile pilot pin pine pink pipe pitch place placed places plain plan plane planet planned
planning plans plant plastic plate platform play played player players playing plays
pleasant please pleased pleasure plenty plot plus pocket poem poet poetry point pointed
pointing points pole police policy polish polite political politician politics poll
pollution pool poor pop popular population porch port portion portrait pose position
positive possess possible possibly post posted posting pot potato potential potentially
pound pour poverty powder power powerful practical practice praise pray prayer predict
prefer preferred pregnant premise prepare prepared presence present presentation
preserve president press pressure pretend pretty prevent previous previously price
prices pride priest primarily primary prime principal principle print printed printer
prior priority prison prisoner privacy private probably problem problems procedure
proceed process processed processes processing produce produced producer product
production profession professional professor profile profit program programs progress
project projects promise promised promote prompt prompted prompting prompts proof
proper properly property proportion proposal propose proposed prospect protect
protected protection protein protest proud prove proved provide provided provides
providing province provision public publication publicly publish published pull pulled
pulling pump punch punish purchase pure purpose pursue push pushed pushing put puts
putting qualify quality quantity quarter queen question questions quick quickly quiet
quietly quit quite quote race racial rack radar radio rail rain raise raised range rank
rapid rapidly rare rarely rate rates rather ratio raw reach reached reaches reaching
react reaction read reader reading reads ready real reality realize realized really
reason reasonable reasonably reasons recall receive received receives receiving recent
recently recipe recognition recognize recognized recommend recommendation record
recorded recording records recover recovery recruit red reduce reduced reduction refer
reference referred reflect reflection reform refuse refused regard regarding regardless
region regional register registered regret regular regularly regulate regulation
reinforce reject relate related relation relationship relative relatively relax release
released relevant relief religion religious rely remain remained remaining remains
remark remarkable remember remembered remind reminded remote remove removed render
rent repair repeat repeated replace replaced reply report reported reporter reports
represent representative reproduce republic request requested require required
requirement requires research researcher resemble reserve resident resist resistance
resolution resolve resolved resort resource resources respect respond responded response
responsibility responsible rest restaurant restore restored restrain restrict result
resulting results resume retail retain retire retreat return returned returning
returns reveal revealed revenue reverse review reviewed reviews revise revolution reward
rhythm rice rich rid ride rider ridge right ring rise rising risk river road rob rock
role roll rolled rolling roof room root rope rose rough roughly round route routine
row royal rub rubber rude ruin rule ruled rules run running runs rural rush sad safe
safely safety said sail sake salad salary sale sales salt same sample sand sandwich sat
satisfy Saturday save saved saving savings saw say saying says scale scan scandal scare
scared scary scene schedule scheme scholar school science scientific scientist scope
score scratch scream screen script scripts sea search searched searching season seat
second secondly secret secretary section sector secure security see seed seeing seek
seem seemed seems seen seize select selected selection self sell selling send sending
sends senior sense sensitive sent sentence separate separated sequence series serious
seriously servant serve served server servers service services session set sets setting
settings settle settlement seven several severe sex shadow shake shall shallow shame
shape share shared shares sharing sharp she sheet shelf shell shelter shift shine ship
shirt shock shoe shoot shop shopping short shortly shot should shoulder shout show
showed showing shown shows shut sick side sides sigh sight sign signal signature
significance significant significantly silence silent silk silly silver similar
similarly simple simply sin since sing singer single sink sir sister sit site sites
situation six size ski skill skills skin sky slave sleep slice slide slight slightly
slip slope slow slowly small smart smell smile smoke smooth snap snow so soap soccer
social society sock soft software soil solar sold soldier sole solely solid solution
solutions solve solved some somebody somehow someone something sometimes somewhat
somewhere son song soon sorry sort soul sound sounds soup source sources south
southern space spare speak speaker speaking special specialist species specific
specifically speech speed spend spending spent spin spirit spiritual split spoke spoken
sponsor sport spot spread spring square squeeze stability stable stack staff stage
stair stake stand standard standing stands star stare start started starting starts
state stated statement states station status stay stayed staying stays steady steal
steam steel steep steer stem step stepped steps stick stiff still stir stock stomach
stone stood stop stopped stopping stops storage store stored stores storm story
straight strain strange stranger strategy stream street strength stress stretch strict
strike string strip stroke strong strongly structure struggle stuck student students
studio study stuff stumble stupid style subject submit submitted subsequent substance
substantial succeed success successful successfully such sudden suddenly suffer
sufficient sugar suggest suggested suggesting suggestion suggests suit suitable suite
sum summary summer summit sun Sunday super superior supply support supported supporter
suppose supposed sure surely surface surgery surprise surprised surprising surround
surrounded survey survive suspect sustain swallow swear sweep sweet swim swing switch
symbol symptom system systems table tables tackle tag tail take taken takes taking
tale talent talk talked talking talks tall tank tap tape target task tasks taste tax
tea teach teacher teaching team tear technical technique technology teen teenager
telephone television tell telling tells temperature temporary ten tend tendency tennis
tent term terms terrible territory terror test tested testing tests text than thank
thanks that the their theirs them themselves then theory therapy there therefore these
they thick thin thing things think thinking thinks third thirsty thirteen thirty this
thoroughly those though thought thoughts thousand thread threat threaten three threw
throat through throughout throw thrown thumb Thursday thus ticket tide tie tied tight
till timber time times timing tiny tip tire tired tissue title to today toe together
toilet told tolerate tomato tomorrow ton tone tongue tonight too took tool tools tooth
top topic total totally touch touched tough tour tournament toward towards tower town
toy track trade tradition traditional traffic tragedy trail train trained trainer
training transfer transform transition translate translation transmit transport trap
trash travel traveled treat treated treatment tree trees tremendous trend trial tribe
trick tried tries trip troop trouble truck true truly trust truth try trying tube
Tuesday tune tunnel turn turned turning turns tv twelve twenty twice twin two type
types typical typically ugly ultimate ultimately unable uncle under undergo understand
understanding understands understood undertake uniform union unique unit unite united
universe university unknown unless unlike unlikely until unusual up update updated
updates updating upgrade upgraded upgrades upgrading upon upper upset urban urge us
usage use used useful user users uses using usual usually utility vacation valid
valley valuable value values van variable variation variety various vary vast vegetable
vehicle venture version versus very vessel veteran via victim victory video view
viewed viewer views village violate violation violent virtual virtue visible vision
visit visited visitor visual vital voice volume volunteer vote voter vs vulnerable
wage wait waited waiting waits wake walk walked walking walks wall wander want wanted
wanting wants war warm warn warned warning wash waste watch watched watching water
wave waves way ways we weak wealth weapon wear weather web website wedding week weekend
weeks weigh weight weird welcome welfare well went were west western wet what whatever
wheel when whenever where whereas wherever whether which while whisper white who
whoever whole whom whose why wide widely widespread wife wild will willing win wind
window windows wine wing winner winter wipe wire wisdom wise wish wished wishes with
within without witness woman women won wonder wonderful wood wooden wool word words
work worked worker workers working works workshop world worried worry worse worst
worth would wound wrap write writer writers writes writing written wrong wrote yard
yeah year years yellow yes yesterday yet you young your yours yourself youth zero zone
agent agents browser browsers subagent subagents typo typos lowercase uppercase casing autocomplete autosuggest
clipboard microphone hotkey hotkeys workflow workflows codebase workspace worktree
screenshot screenshots timestamp timestamps filename filepath username password database
endpoint endpoints frontend backend middleware refactor refactored refactoring runtime
startup shutdown timeout latency payload payloads cache cached caching token tokens
prompted prompting llm cpu gpu api sdk cli gui ide url uri json html css yaml toml sql
regex snippet snippets dictation dictate dictated transcription transcript transcriber
linux windows macos wayland hyprland electron typescript javascript python rust golang
auto sub app apps git hub neon whatsapp github zero flash flashed flashes flashing
spell spells spelled spelling dictionary dictionaries launch launches launching chat chats
ran ate bitten blew blown drank drunk drew drawn drove driven eaten flew flown forgave forgiven
froze frozen hid hidden lit rode ridden rang rung rose risen sang sung sank sunk shook shaken
swam swum swore sworn tore torn woke woken
setup grep rg diff stdin stdout stderr stdio curl wget chmod chown sudo env init lint typecheck
vite esbuild npm npx pnpm yarn node bun deno daemon systemd
saint saints boss bosses cube cubes noon scent senate flush flesh flask mint hint hints font
belt bolt chart shirt skirt fort alert insert assert revert convert desert snort dart cart
vent bent dent lent cent cents pint lint tint rant pant aunt haunt vault halt melt jolt volt
cult tilt quilt guilt flirt curt blurt spurt divert invert exert overt avert
`;

const PROPER_CASE_DEFAULTS = new Map<string, string>([
  ['whatsapp', 'WhatsApp'],
  ['github', 'GitHub'],
  ['typescript', 'TypeScript'],
  ['javascript', 'JavaScript'],
  ['macos', 'macOS'],
  ['iphone', 'iPhone'],
  ['ipad', 'iPad'],
  ['ios', 'iOS'],
  ['openai', 'OpenAI'],
  ['youtube', 'YouTube'],
  ['linkedin', 'LinkedIn'],
  ['chatgpt', 'ChatGPT'],
]);

/**
 * Unambiguous fast-typing misspellings, dropped-letter shortcuts, and missing
 * apostrophes (checked only when the input token is NOT in COMMON_WORDS or user's dictionary).
 */
const COMMON_TYPO_MAP = new Map<string, string>([
  // Classic transpositions & common spelling mistakes
  ['teh', 'the'],
  ['adn', 'and'],
  ['taht', 'that'],
  ['htat', 'that'],
  ['waht', 'what'],
  ['wiht', 'with'],
  ['becuase', 'because'],
  ['beacuse', 'because'],
  ['recieve', 'receive'],
  ['recieved', 'received'],
  ['definately', 'definitely'],
  ['definatly', 'definitely'],
  ['seperate', 'separate'],
  ['seperated', 'separated'],
  ['occured', 'occurred'],
  ['untill', 'until'],
  ['wich', 'which'],
  ['thier', 'their'],
  ['freind', 'friend'],
  ['acheive', 'achieve'],
  ['beleive', 'believe'],
  ['wierd', 'weird'],
  ['grammer', 'grammar'],
  ['calender', 'calendar'],
  ['existance', 'existence'],
  ['maintenence', 'maintenance'],
  ['occurence', 'occurrence'],
  ['persistant', 'persistent'],
  ['prefered', 'preferred'],
  ['refered', 'referred'],
  ['succesful', 'successful'],
  ['sucess', 'success'],
  ['tommorow', 'tomorrow'],
  ['tomorow', 'tomorrow'],
  ['togehter', 'together'],
  ['togather', 'together'],
  ['truely', 'truly'],
  ['usefull', 'useful'],
  ['writen', 'written'],
  ['writting', 'writing'],
  ['begining', 'beginning'],
  ['comming', 'coming'],
  ['runing', 'running'],
  ['stoped', 'stopped'],
  ['planed', 'planned'],
  ['hopeing', 'hoping'],
  ['makeing', 'making'],
  ['takeing', 'taking'],
  ['useing', 'using'],
  ['haveing', 'having'],
  ['giveing', 'giving'],
  ['liveing', 'living'],
  ['moveing', 'moving'],
  ['loveing', 'loving'],
  ['changeing', 'changing'],
  ['createing', 'creating'],
  ['deleteing', 'deleting'],
  ['updateing', 'updating'],
  ['upgradeing', 'upgrading'],
  ['neccessary', 'necessary'],
  ['accomodate', 'accommodate'],
  ['embarass', 'embarrass'],

  // Phonetic / dropped-letter / fast-typing shortcuts
  ['dictory', 'dictionary'],
  ['dication', 'discussion'],
  ['undertadtd', 'understand'],
  ['cobersation', 'conversation'],
  ['whatspa', 'WhatsApp'],
  ['als', 'also'],
  ['promt', 'prompt'],
  ['bvoard', 'board'],
  ['sugess', 'suggest'],
  ['updagtred', 'upgraded'],
  ['updgared', 'upgraded'],
  ['poinet', 'pointed'],
  ['fomr', 'from'],

  // Missing apostrophe contractions (never real words without apostrophe)
  ['dont', "don't"],
  ['didnt', "didn't"],
  ['doesnt', "doesn't"],
  ['isnt', "isn't"],
  ['arent', "aren't"],
  ['wasnt', "wasn't"],
  ['werent', "weren't"],
  ['havent', "haven't"],
  ['hasnt', "hasn't"],
  ['hadnt', "hadn't"],
  ['wouldnt', "wouldn't"],
  ['couldnt', "couldn't"],
  ['shouldnt', "shouldn't"],
  ['youre', "you're"],
  ['theyre', "they're"],
  ['youve', "you've"],
  ['theyve', "they've"],
  ['weve', "we've"],
  ['youll', "you'll"],
  ['theyll', "they'll"],
]);

/**
 * Compound words that should be merged when accidentally split by a single space.
 * Intentionally excludes pairs that are commonly valid separate words (e.g. "in to", "every one", "may be").
 */
const COMPOUND_MERGE_SET = new Set<string>([
  'keyboard',
  'keyboards',
  'subagent',
  'subagents',
  'clipboard',
  'microphone',
  'screenshot',
  'screenshots',
  'codebase',
  'workspace',
  'worktree',
  'workflow',
  'workflows',
  'database',
  'databases',
  'username',
  'password',
  'filename',
  'filepath',
  'timestamp',
  'timestamps',
  'autocomplete',
  'understand',
  'understood',
  'because',
  'together',
  'tomorrow',
  'tonight',
  'today',
  'already',
  'almost',
  'always',
  'between',
  'without',
  'within',
  'however',
  'therefore',
  'whatever',
  'whenever',
  'wherever',
  'download',
  'downloads',
  'upload',
  'uploads',
  'upgrade',
  'upgraded',
  'startup',
  'shutdown',
  'timeout',
  'runtime',
  'background',
  'foreground',
  'whatsapp',
  'github',
]);

const HYPHENATED_COMPOUNDS = new Map<string, string>([
  ['auto suggest', 'auto-suggest'],
  ['auto suggested', 'auto-suggested'],
  ['auto suggesting', 'auto-suggesting'],
  ['auto complete', 'auto-complete'],
]);

const LEFT_SPLIT_ANCHORS = new Set<string>([
  'a',
  'i',
  'to',
  'in',
  'on',
  'of',
  'at',
  'by',
  'is',
  'it',
  'my',
  'we',
  'he',
  'be',
  'do',
  'go',
  'so',
  'no',
  'or',
  'an',
  'as',
  'if',
  'up',
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'use',
  'his',
  'has',
  'she',
  'two',
  'way',
  'who',
  'did',
  'get',
  'may',
  'new',
  'now',
  'old',
  'see',
  'him',
  'how',
  'its',
]);

const ABBREV_NO_SENTENCE_END = new Set<string>([
  'eg',
  'ie',
  'etc',
  'vs',
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'inc',
  'ltd',
]);

const STANDALONE_I_CONTRACTIONS = new Map<string, string>([
  ['i', 'I'],
  ["i'm", "I'm"],
  ["i've", "I've"],
  ["i'll", "I'll"],
  ["i'd", "I'd"],
]);

// --- Precomputed Static Vocabulary & Indexes ---

const COMMON_WORDS = new Set<string>();
const WORD_RANK = new Map<string, number>();
const WORD_MASK = new Map<string, number>();
const DEL1_INDEX = new Map<string, string[]>();
const BY_FIRST_CHAR = new Map<string, string[]>();

function computeCharMask(word: string): number {
  let mask = 0;
  for (let i = 0; i < word.length; i++) {
    const code = word.charCodeAt(i) - 97;
    if (code >= 0 && code < 26) {
      mask |= 1 << code;
    }
  }
  return mask;
}

function popcount32(n: number): number {
  let x = n;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

(function initStaticVocabulary(): void {
  const tokens = COMMON_WORDS_RAW.trim().split(/\s+/);
  let rank = 0;
  for (const raw of tokens) {
    const w = raw.toLowerCase();
    if (!w || COMMON_WORDS.has(w)) continue;
    COMMON_WORDS.add(w);
    WORD_RANK.set(w, rank++);

    if (/^[a-z]+$/.test(w)) {
      WORD_MASK.set(w, computeCharMask(w));
      const first = w[0];
      let bucket = BY_FIRST_CHAR.get(first);
      if (!bucket) {
        bucket = [];
        BY_FIRST_CHAR.set(first, bucket);
      }
      bucket.push(w);

      if (w.length >= 2) {
        for (let i = 0; i < w.length; i++) {
          const del = w.slice(0, i) + w.slice(i + 1);
          let list = DEL1_INDEX.get(del);
          if (!list) {
            list = [];
            DEL1_INDEX.set(del, list);
          }
          list.push(w);
        }
      }
    }
  }
})();

/**
 * Shared read-only vocabulary of common English words used to prevent
 * phonetic fuzzy matchers from overwriting valid English words.
 */
export const COMMON_ENGLISH_WORDS: ReadonlySet<string> = COMMON_WORDS;

// --- QWERTY Distance & Weighted Damerau-Levenshtein ---

const VOWELS_OR_SOFT = new Set(['a', 'e', 'i', 'o', 'u', 'h', 'n', 'p', 't', 'd']);

export function qwertyDistance(a: string, b: string): number {
  if (a === b) return 0;
  const ca = QWERTY_COORDS[a];
  const cb = QWERTY_COORDS[b];
  if (!ca || !cb) return 4;
  const dx = ca[0] - cb[0];
  const dy = ca[1] - cb[1];
  return Math.hypot(dx, dy);
}

function isQwertyNeighbor(a: string, b: string): boolean {
  return qwertyDistance(a, b) <= 1.55;
}

const MAX_DP_LEN = 64;
// Flat 2D buffer for weighted DL (safe up to 64x64)
const dpMatrix = new Float64Array(MAX_DP_LEN * MAX_DP_LEN);

export function weightedDamerauLevenshtein(typed: string, candidate: string): number {
  const n = typed.length;
  const m = candidate.length;
  if (n === 0) return m;
  if (m === 0) return n;
  if (n >= MAX_DP_LEN || m >= MAX_DP_LEN) {
    return Math.abs(n - m) + 4;
  }

  const stride = m + 1;
  dpMatrix[0] = 0;
  for (let i = 1; i <= n; i++) {
    const ch = typed[i - 1];
    const extraDup = i >= 2 && ch === typed[i - 2];
    const extraAdj =
      (i >= 2 && isQwertyNeighbor(ch, typed[i - 2])) ||
      (i < n && isQwertyNeighbor(ch, typed[i]));
    const insCost = extraDup ? 0.5 : extraAdj ? 0.65 : 1.05;
    dpMatrix[i * stride] = dpMatrix[(i - 1) * stride] + insCost;
  }

  for (let j = 1; j <= m; j++) {
    const ch = candidate[j - 1];
    const isDouble = (j >= 2 && ch === candidate[j - 2]) || (j < m && ch === candidate[j]);
    const delCost = isDouble ? 0.55 : VOWELS_OR_SOFT.has(ch) ? 0.85 : 1.0;
    dpMatrix[j] = dpMatrix[j - 1] + delCost;
  }

  for (let i = 1; i <= n; i++) {
    const aCh = typed[i - 1];
    const extraDup = (i >= 2 && aCh === typed[i - 2]) || (i < n && aCh === typed[i]);
    const extraAdj =
      (i >= 2 && isQwertyNeighbor(aCh, typed[i - 2])) ||
      (i < n && isQwertyNeighbor(aCh, typed[i]));
    const insCost = extraDup ? 0.5 : extraAdj ? 0.65 : 1.05;

    for (let j = 1; j <= m; j++) {
      const bCh = candidate[j - 1];
      let subCost = 0;
      if (aCh !== bCh) {
        const dist = qwertyDistance(aCh, bCh);
        subCost = dist <= 1.55 ? 0.65 : dist <= 2.3 ? 1.0 : 1.25;
      }

      const isDouble = (j >= 2 && bCh === candidate[j - 2]) || (j < m && bCh === candidate[j]);
      const delCost = isDouble ? 0.55 : VOWELS_OR_SOFT.has(bCh) ? 0.85 : 1.0;

      let best = dpMatrix[(i - 1) * stride + (j - 1)] + subCost;
      const del = dpMatrix[i * stride + (j - 1)] + delCost;
      if (del < best) best = del;
      const ins = dpMatrix[(i - 1) * stride + j] + insCost;
      if (ins < best) best = ins;

      if (i > 1 && j > 1 && aCh === candidate[j - 2] && typed[i - 2] === bCh) {
        const trans = dpMatrix[(i - 2) * stride + (j - 2)] + 0.7;
        if (trans < best) best = trans;
      }

      dpMatrix[i * stride + j] = best;
    }
  }

  let cost = dpMatrix[n * stride + m];

  // Penalize mismatching the very first letter unless it's a first-two swap (e.g. htat -> that)
  if (typed[0] !== candidate[0]) {
    const firstSwap = n >= 2 && m >= 2 && typed[0] === candidate[1] && typed[1] === candidate[0];
    if (!firstSwap) {
      cost += isQwertyNeighbor(typed[0], candidate[0]) ? 0.45 : 1.1;
    }
  }

  return cost;
}

const bagCounts = new Int16Array(26);

function computeMultisetDiff(a: string, b: string): number {
  bagCounts.fill(0);
  for (let i = 0; i < a.length; i++) {
    const idx = a.charCodeAt(i) - 97;
    if (idx >= 0 && idx < 26) bagCounts[idx]++;
  }
  for (let i = 0; i < b.length; i++) {
    const idx = b.charCodeAt(i) - 97;
    if (idx >= 0 && idx < 26) bagCounts[idx]--;
  }
  let diff = 0;
  for (let i = 0; i < 26; i++) {
    const v = bagCounts[i];
    diff += v < 0 ? -v : v;
  }
  return diff;
}

function maxAllowedDistance(targetLen: number, isCapitalizedInput: boolean): number {
  if (isCapitalizedInput) {
    // Be conservative on capitalized unknown words (like proper names)
    return targetLen <= 5 ? 0.85 : 0.95;
  }
  if (targetLen <= 2) return 0;
  if (targetLen === 3) return 0.95;
  if (targetLen === 4) return 1.1;
  if (targetLen <= 6) return 2.1;
  return Math.min(3.0, Math.floor(targetLen * 0.36));
}

function scoreCandidate(
  typedLower: string,
  candidateLower: string,
  isCapitalizedInput: boolean
): number {
  const dl = weightedDamerauLevenshtein(typedLower, candidateLower);

  // Check scramble / anagram similarity for mid-word scrambles (e.g. updgared -> upgraded, suabget -> subagent)
  if (
    !isCapitalizedInput &&
    typedLower.length >= 4 &&
    candidateLower.length >= 4 &&
    typedLower[0] === candidateLower[0] &&
    Math.abs(typedLower.length - candidateLower.length) <= 1
  ) {
    const bagDiff = computeMultisetDiff(typedLower, candidateLower);
    if (bagDiff <= 1 && dl <= Math.ceil(candidateLower.length * 0.5)) {
      const scrambleScore = 0.75 + bagDiff * 0.45 + 0.08 * dl;
      return Math.min(dl, scrambleScore);
    }
  }

  return dl;
}

// --- Dictionary Indexing ---

interface DictSingleEntry {
  lower: string;
  target: string;
  mask: number;
}

interface DictPhraseEntry {
  wordsLower: string[];
  joinedLower: string;
  target: string;
}

interface DictionaryIndex {
  exactSingle: Map<string, string>;
  singles: DictSingleEntry[];
  phrases: DictPhraseEntry[];
}

function buildDictionaryIndex(entries: DictionaryEntry[]): DictionaryIndex {
  const exactSingle = new Map<string, string>();
  const singles: DictSingleEntry[] = [];
  const phrases: DictPhraseEntry[] = [];
  const seenSingleLower = new Set<string>();

  for (const entry of entries) {
    if (!entry.enabled) continue;
    const rawPhrase = entry.phrase.trim();
    if (!rawPhrase) continue;
    const rawReplacement = entry.replacement?.trim() ?? '';
    const target = rawReplacement.length > 0 ? rawReplacement : rawPhrase;

    const matchKeys = [rawPhrase];
    if (rawReplacement.length > 0 && rawReplacement.toLowerCase() !== rawPhrase.toLowerCase()) {
      matchKeys.push(rawReplacement);
    }

    for (const key of matchKeys) {
      const lower = key.toLowerCase();
      if (/\s+/.test(lower)) {
        const wordsLower = lower.split(/\s+/);
        const joinedLower = wordsLower.join('');
        phrases.push({
          wordsLower,
          joinedLower,
          target,
        });
        if (!exactSingle.has(joinedLower)) {
          exactSingle.set(joinedLower, target);
          if (/^[a-z]+$/.test(joinedLower) && !seenSingleLower.has(joinedLower)) {
            seenSingleLower.add(joinedLower);
            singles.push({
              lower: joinedLower,
              target,
              mask: computeCharMask(joinedLower),
            });
          }
        }
      } else {
        exactSingle.set(lower, target);
        if (/^[a-z]+$/.test(lower) && !seenSingleLower.has(lower)) {
          seenSingleLower.add(lower);
          singles.push({
            lower,
            target,
            mask: computeCharMask(lower),
          });
        }
      }
    }
  }

  // Sort phrases longest-first so longer phrases match before shorter sub-phrases
  phrases.sort((a, b) => b.wordsLower.length - a.wordsLower.length);

  return { exactSingle, singles, phrases };
}

// --- Core Single-Word Resolution ---

function applyInputCase(original: string, fixed: string): string {
  if (original.length > 0 && original[0] >= 'A' && original[0] <= 'Z') {
    if (fixed.length > 0 && fixed[0] >= 'a' && fixed[0] <= 'z' && !/[a-z][A-Z]/.test(fixed)) {
      return fixed[0].toUpperCase() + fixed.slice(1);
    }
  }
  return fixed;
}

function findBestVocabMatch(
  lower: string,
  isCapitalizedInput: boolean,
  dictIndex: DictionaryIndex,
  maxOverride?: number
): { word: string; score: number; fromDict: boolean } | null {
  if (!/^[a-z]+$/.test(lower)) return null;

  const typedMask = computeCharMask(lower);
  let bestWord: string | null = null;
  let bestScore = Infinity;
  let bestFromDict = false;
  let bestRank = Infinity;

  // 1. Dictionary fuzzy candidates first (with slight priority tie-breaker)
  for (const d of dictIndex.singles) {
    if (Math.abs(d.lower.length - lower.length) > 3) continue;
    if (popcount32(d.mask ^ typedMask) > 4) continue;
    const limit = maxOverride ?? maxAllowedDistance(d.lower.length, isCapitalizedInput);
    const s = scoreCandidate(lower, d.lower, isCapitalizedInput);
    if (s <= limit && (s < bestScore - 0.05 || (Math.abs(s - bestScore) <= 0.05 && !bestFromDict))) {
      bestScore = s;
      bestWord = d.target;
      bestFromDict = true;
      bestRank = -1;
    }
  }

  // 2. Common vocabulary candidates via SymSpell 1-delete + first/second-char bitmask buckets
  const seen = new Set<string>();
  const consider = (cand: string): void => {
    if (seen.has(cand)) return;
    seen.add(cand);
    if (Math.abs(cand.length - lower.length) > 3) return;
    const candMask = WORD_MASK.get(cand);
    if (candMask !== undefined && popcount32(candMask ^ typedMask) > 4) return;

    const limit = maxOverride ?? maxAllowedDistance(cand.length, isCapitalizedInput);
    const rawScore = scoreCandidate(lower, cand, isCapitalizedInput);
    if (rawScore > limit) return;
    const maskDiff = candMask !== undefined ? popcount32(candMask ^ typedMask) : 0;
    const s = rawScore + 0.03 * maskDiff;

    const rank = WORD_RANK.get(cand) ?? 99999;
    if (
      s < bestScore - 0.01 ||
      (Math.abs(s - bestScore) <= 0.01 && !bestFromDict && rank < bestRank)
    ) {
      bestScore = s;
      bestWord = dictIndex.exactSingle.get(cand) ?? PROPER_CASE_DEFAULTS.get(cand) ?? cand;
      bestFromDict = dictIndex.exactSingle.has(cand);
      bestRank = rank;
    }
  };

  // SymSpell 1-delete lookup (handles all dist=1 edits including first-char errors)
  const exactBucket = DEL1_INDEX.get(lower);
  if (exactBucket) {
    for (const c of exactBucket) consider(c);
  }
  if (lower.length >= 2) {
    for (let i = 0; i < lower.length; i++) {
      const del = lower.slice(0, i) + lower.slice(i + 1);
      const bucket = DEL1_INDEX.get(del);
      if (bucket) {
        for (const c of bucket) consider(c);
      }
    }
  }

  // First-char + second-char buckets (handles scrambles and multi-edit typos)
  if (lower.length >= 3) {
    const b1 = BY_FIRST_CHAR.get(lower[0]);
    if (b1) {
      for (const c of b1) consider(c);
    }
    if (lower[1] !== lower[0]) {
      const b2 = BY_FIRST_CHAR.get(lower[1]);
      if (b2) {
        for (const c of b2) consider(c);
      }
    }
  }

  if (!bestWord) return null;
  return { word: bestWord, score: bestScore, fromDict: bestFromDict };
}

function resolveSimpleWord(core: string, dictIndex: DictionaryIndex): string {
  const lower = core.toLowerCase();

  // 1. Standalone i / i-contractions
  const iForm = STANDALONE_I_CONTRACTIONS.get(lower);
  if (iForm && core === lower) {
    return iForm;
  }

  // 2. Exact Dictionary match (highest priority)
  const dictExact = dictIndex.exactSingle.get(lower);
  if (dictExact !== undefined) {
    return dictExact;
  }

  // 3. Built-in proper-cased brand defaults when typed all-lowercase
  if (core === lower) {
    const properDefault = PROPER_CASE_DEFAULTS.get(lower);
    if (properDefault !== undefined) {
      return properDefault;
    }
  }

  // 4. Exact match in common English vocabulary (O(1) safety net)
  if (COMMON_WORDS.has(lower)) {
    return core;
  }

  const isCapitalizedInput =
    core.length > 0 && core[0] >= 'A' && core[0] <= 'Z' && core.slice(1) === core.slice(1).toLowerCase();

  // 5. Curated unambiguous typo / shortcut map
  const mapped = COMMON_TYPO_MAP.get(lower);
  if (mapped !== undefined) {
    const mappedLower = mapped.toLowerCase();
    const dictMapped = dictIndex.exactSingle.get(mappedLower);
    if (dictMapped !== undefined) return dictMapped;
    return isCapitalizedInput ? applyInputCase(core, mapped) : mapped;
  }

  // 6. Algorithmic fuzzy lookup
  if (/^[a-z]+$/.test(lower) && lower.length >= 3) {
    const match = findBestVocabMatch(lower, isCapitalizedInput, dictIndex);
    if (match) {
      return match.fromDict || PROPER_CASE_DEFAULTS.has(match.word.toLowerCase())
        ? match.word
        : applyInputCase(core, match.word);
    }

    // 7. Single-token missing space fallback (e.g., "alot" -> "a lot", "akeyboard" -> "a keyboard")
    if (!isCapitalizedInput && lower.length >= 4) {
      for (let k = 1; k <= Math.min(3, lower.length - 3); k++) {
        const left = lower.slice(0, k);
        const right = lower.slice(k);
        if (!LEFT_SPLIT_ANCHORS.has(left)) continue;
        if (left.length === 1 && right.length < 3) continue;
        if (COMMON_WORDS.has(right)) {
          return `${left === 'i' ? 'I' : left} ${right}`;
        }
      }
    }
  }

  return core;
}

function resolveWordCore(core: string, dictIndex: DictionaryIndex): string {
  // Handle hyphenated words part-by-part unless whole token is in dictionary or common words
  if (core.includes('-')) {
    const lower = core.toLowerCase();
    const dictExact = dictIndex.exactSingle.get(lower);
    if (dictExact !== undefined) return dictExact;
    if (COMMON_WORDS.has(lower)) return core;
    return core
      .split('-')
      .map((part) => (part.length > 0 ? resolveSimpleWord(part, dictIndex) : part))
      .join('-');
  }

  // Handle possessive `'s` on dictionary / typoed base words (e.g., "maniteja's", "whatspa's")
  if (core.toLowerCase().endsWith("'s") && core.length > 3) {
    const lower = core.toLowerCase();
    if (COMMON_WORDS.has(lower)) return core;
    const base = core.slice(0, -2);
    const fixedBase = resolveSimpleWord(base, dictIndex);
    return `${fixedBase}'s`;
  }

  return resolveSimpleWord(core, dictIndex);
}

// --- Tokenizer & Protected Token Detection ---

interface Segment {
  kind: 'ws' | 'protected' | 'word' | 'punct';
  raw: string;
  leadPunct?: string;
  core?: string;
  trailPunct?: string;
}

const URL_RE = /^(?:https?:\/\/|ftp:\/\/|www\.)\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLI_FLAG_RE = /^--?[a-zA-Z0-9][\w=-]*$/;

function isProtectedBody(body: string): boolean {
  if (!body) return false;
  if (URL_RE.test(body)) return true;
  if (EMAIL_RE.test(body)) return true;
  if (CLI_FLAG_RE.test(body)) return true;
  if (body.includes('/') || body.includes('\\')) return true;
  if (body.includes('_') || /\d/.test(body)) return true;
  if (/[$#@=+*<>|~`{}]/.test(body)) return true;

  // Internal dots: domains, filenames (typoFixer.ts), abbreviations (e.g., i.e.), versions
  if (body.includes('.')) return true;

  // camelCase or internal uppercase transition (e.g. myVar, useState, WhatsApp, GitHub)
  if (/[a-z][A-Z]/.test(body)) return true;

  // ALL CAPS acronym of length >= 2 (CPU, GPU, API, LLM)
  if (body.length >= 2 && /^[A-Z]+(?:'[A-Z]+)?$/.test(body)) return true;

  return false;
}

function tokenize(text: string): Segment[] {
  const parts = text.split(/(\s+)/);
  const segments: Segment[] = [];

  for (const part of parts) {
    if (part.length === 0) continue;
    if (/^\s+$/.test(part)) {
      segments.push({ kind: 'ws', raw: part });
      continue;
    }

    // Check URL/flag/path before stripping outer punctuation, except trailing sentence punct on URLs
    if (URL_RE.test(part)) {
      const m = part.match(/^(.+?)([.,!?;:]+)$/);
      if (m) {
        segments.push({ kind: 'protected', raw: m[1] });
        segments.push({ kind: 'punct', raw: m[2] });
      } else {
        segments.push({ kind: 'protected', raw: part });
      }
      continue;
    }

    // Keep abbreviations like e.g. / i.e. intact so their trailing dot doesn't trigger sentence caps
    if (/^(?:e\.g\.|i\.e\.|etc\.|u\.s\.|a\.m\.|p\.m\.)$/i.test(part)) {
      segments.push({ kind: 'protected', raw: part });
      continue;
    }

    // Separate leading/trailing wrapper punctuation
    const leadMatch = part.match(/^([^a-zA-Z0-9]+)(.*)$/);
    const leadPunct = leadMatch ? leadMatch[1] : '';
    let rest = leadMatch ? leadMatch[2] : part;

    if (!rest) {
      segments.push({ kind: 'punct', raw: part });
      continue;
    }

    const trailMatch = rest.match(/^(.*?)([^a-zA-Z0-9]+)$/);
    const core = trailMatch ? trailMatch[1] : rest;
    const trailPunct = trailMatch ? trailMatch[2] : '';

    // Check CLI flags before stripping leading `-`
    if (CLI_FLAG_RE.test(part.replace(/[.,!?;:]+$/, ''))) {
      const m = part.match(/^(--?[a-zA-Z0-9][\w=-]*)([.,!?;:]*)$/);
      if (m) {
        segments.push({ kind: 'protected', raw: m[1] });
        if (m[2]) segments.push({ kind: 'punct', raw: m[2] });
        continue;
      }
    }

    // Check paths starting with `/` or `./` or `~/`
    if (/^(?:\.?\.?\/|~\/)/.test(part)) {
      const m = part.match(/^(.+?)([.,!?;:]*)$/);
      if (m) {
        segments.push({ kind: 'protected', raw: m[1] });
        if (m[2]) segments.push({ kind: 'punct', raw: m[2] });
        continue;
      }
    }

    if (isProtectedBody(core)) {
      // Keep original protected token intact (split off trailing punct only if needed for sentence cap)
      if (leadPunct) segments.push({ kind: 'punct', raw: leadPunct });
      segments.push({ kind: 'protected', raw: core });
      if (trailPunct) segments.push({ kind: 'punct', raw: trailPunct });
      continue;
    }

    if (/^[a-zA-Z]+(?:['-][a-zA-Z]+)*$/.test(core)) {
      segments.push({
        kind: 'word',
        raw: part,
        leadPunct,
        core,
        trailPunct,
      });
    } else {
      segments.push({ kind: 'protected', raw: part });
    }
  }

  return segments;
}

// --- Multi-Word & Space-Split Passes ---

function isPlainSpace(seg: Segment | undefined): boolean {
  return seg?.kind === 'ws' && seg.raw === ' ';
}

function isJoinablePair(segments: Segment[], i: number): boolean {
  const a = segments[i];
  const sp = segments[i + 1];
  const b = segments[i + 2];
  return (
    a?.kind === 'word' &&
    isPlainSpace(sp) &&
    b?.kind === 'word' &&
    (a.trailPunct ?? '') === '' &&
    (b.leadPunct ?? '') === ''
  );
}

function applyMultiWordDictionaryPass(segments: Segment[], dictIndex: DictionaryIndex): Segment[] {
  if (dictIndex.phrases.length === 0) return segments;

  const out: Segment[] = [];
  let i = 0;
  while (i < segments.length) {
    let matched = false;

    for (const phrase of dictIndex.phrases) {
      const n = phrase.wordsLower.length;
      const endIdx = i + (n - 1) * 2;
      if (endIdx >= segments.length) continue;

      let shapeOk = true;
      const cores: string[] = [];
      for (let k = 0; k < n; k++) {
        const seg = segments[i + k * 2];
        if (seg.kind !== 'word') {
          shapeOk = false;
          break;
        }
        if (k < n - 1 && !isPlainSpace(segments[i + k * 2 + 1])) {
          shapeOk = false;
          break;
        }
        if (k > 0 && (seg.leadPunct ?? '') !== '') {
          shapeOk = false;
          break;
        }
        if (k < n - 1 && (seg.trailPunct ?? '') !== '') {
          shapeOk = false;
          break;
        }
        cores.push(seg.core!.toLowerCase());
      }
      if (!shapeOk) continue;

      // Exact case-insensitive phrase match or close per-word fuzzy match
      let allClose = true;
      for (let k = 0; k < n; k++) {
        const c = cores[k];
        const t = phrase.wordsLower[k];
        if (c === t) continue;
        const limit = t.length <= 4 ? 1.1 : 1.5;
        if (weightedDamerauLevenshtein(c, t) > limit) {
          allClose = false;
          break;
        }
      }

      if (allClose) {
        out.push({
          kind: 'word',
          raw: phrase.target,
          leadPunct: segments[i].leadPunct ?? '',
          core: phrase.target,
          trailPunct: segments[endIdx].trailPunct ?? '',
        });
        i = endIdx + 1;
        matched = true;
        break;
      }
    }

    if (!matched) {
      out.push(segments[i]);
      i++;
    }
  }

  return out;
}

function tryShiftedSpaceSplit(
  w1: string,
  w2: string,
  dictIndex: DictionaryIndex
): [string, string] | null {
  const l1 = w1.toLowerCase();
  const l2 = w2.toLowerCase();
  if (!/^[a-z]+$/.test(l1) || !/^[a-z]+$/.test(l2)) return null;

  // Shift boundary leftward inside w1 only when w1 itself is NOT a valid word: e.g. "akey" + "bvoard" -> "a" + "keyboard"
  if (!COMMON_WORDS.has(l1) && !dictIndex.exactSingle.has(l1)) {
    const l2Valid = COMMON_WORDS.has(l2) || dictIndex.exactSingle.has(l2);
    for (let k = 1; k < l1.length; k++) {
      const left = l1.slice(0, k);
      if (!LEFT_SPLIT_ANCHORS.has(left)) continue;
      const rightRaw = l1.slice(k) + l2;
      if (rightRaw.length < 4) continue;
      if (l2Valid && !COMPOUND_MERGE_SET.has(rightRaw) && !dictIndex.exactSingle.has(rightRaw)) {
        continue;
      }

      if (dictIndex.exactSingle.has(rightRaw)) {
        return [left === 'i' ? 'I' : left, dictIndex.exactSingle.get(rightRaw)!];
      }
      if (COMMON_WORDS.has(rightRaw)) {
        return [left === 'i' ? 'I' : left, PROPER_CASE_DEFAULTS.get(rightRaw) ?? rightRaw];
      }
      const fuzzy = findBestVocabMatch(rightRaw, false, dictIndex, 1.15);
      if (fuzzy) {
        return [left === 'i' ? 'I' : left, fuzzy.word];
      }
    }
  }

  // Shift boundary rightward inside w2 only when BOTH w1 and w2 are invalid words: e.g. "thek" + "eyboard" -> "the" + "keyboard"
  if (
    !COMMON_WORDS.has(l1) &&
    !dictIndex.exactSingle.has(l1) &&
    !COMMON_WORDS.has(l2) &&
    !dictIndex.exactSingle.has(l2)
  ) {
    for (let k = 1; k < l2.length; k++) {
      const right = l2.slice(k);
      if (!LEFT_SPLIT_ANCHORS.has(right)) continue;
      const leftRaw = l1 + l2.slice(0, k);
      if (leftRaw.length < 4) continue;

      if (dictIndex.exactSingle.has(leftRaw)) {
        return [dictIndex.exactSingle.get(leftRaw)!, right === 'i' ? 'I' : right];
      }
      if (COMMON_WORDS.has(leftRaw)) {
        return [PROPER_CASE_DEFAULTS.get(leftRaw) ?? leftRaw, right === 'i' ? 'I' : right];
      }
      const fuzzy = findBestVocabMatch(leftRaw, false, dictIndex, 1.15);
      if (fuzzy) {
        return [fuzzy.word, right === 'i' ? 'I' : right];
      }
    }
  }

  return null;
}

function applySpaceSplitAndCompoundPass(
  segments: Segment[],
  dictIndex: DictionaryIndex
): Segment[] {
  const out: Segment[] = [];
  let i = 0;

  while (i < segments.length) {
    if (isJoinablePair(segments, i)) {
      const a = segments[i];
      const b = segments[i + 2];
      const w1 = a.core!;
      const w2 = b.core!;
      const l1 = w1.toLowerCase();
      const l2 = w2.toLowerCase();

      // 1. Check direct compound merge into dictionary entry or known compound word
      const rawJoined = l1 + l2;
      const fixed1 = resolveWordCore(w1, dictIndex).toLowerCase();
      const fixed2 = resolveWordCore(w2, dictIndex).toLowerCase();
      const fixedJoined = fixed1 + fixed2;

      const dictJoined =
        dictIndex.exactSingle.get(rawJoined) ?? dictIndex.exactSingle.get(fixedJoined);
      if (dictJoined !== undefined) {
        out.push({
          kind: 'word',
          raw: dictJoined,
          leadPunct: a.leadPunct ?? '',
          core: dictJoined,
          trailPunct: b.trailPunct ?? '',
        });
        i += 3;
        continue;
      }

      if (COMPOUND_MERGE_SET.has(rawJoined) || COMPOUND_MERGE_SET.has(fixedJoined)) {
        const target = COMPOUND_MERGE_SET.has(rawJoined) ? rawJoined : fixedJoined;
        const cased = PROPER_CASE_DEFAULTS.get(target) ?? applyInputCase(w1, target);
        out.push({
          kind: 'word',
          raw: cased,
          leadPunct: a.leadPunct ?? '',
          core: cased,
          trailPunct: b.trailPunct ?? '',
        });
        i += 3;
        continue;
      }

      // 2. Check hyphenated compound merge (e.g. "auto sugess" -> "auto-suggest")
      const hyphenTarget =
        HYPHENATED_COMPOUNDS.get(`${l1} ${l2}`) ??
        HYPHENATED_COMPOUNDS.get(`${fixed1} ${fixed2}`);
      if (hyphenTarget !== undefined) {
        const cased = applyInputCase(w1, hyphenTarget);
        out.push({
          kind: 'word',
          raw: cased,
          leadPunct: a.leadPunct ?? '',
          core: cased,
          trailPunct: b.trailPunct ?? '',
        });
        i += 3;
        continue;
      }

      // 3. Shifted space split when at least one token is unknown (e.g. "akey bvoard" -> "a keyboard")
      if (!COMMON_WORDS.has(l1) || !COMMON_WORDS.has(l2)) {
        const splitFix = tryShiftedSpaceSplit(w1, w2, dictIndex);
        if (splitFix) {
          out.push({
            kind: 'word',
            raw: splitFix[0],
            leadPunct: a.leadPunct ?? '',
            core: applyInputCase(w1, splitFix[0]),
            trailPunct: '',
          });
          out.push(segments[i + 1]);
          out.push({
            kind: 'word',
            raw: splitFix[1],
            leadPunct: '',
            core: splitFix[1],
            trailPunct: b.trailPunct ?? '',
          });
          i += 3;
          continue;
        }
      }
    }

    out.push(segments[i]);
    i++;
  }

  return out;
}

// --- Capitalization & Reconstruction ---

function capitalizeSentenceStart(core: string): string {
  if (!core) return core;
  if (core[0] >= 'a' && core[0] <= 'z' && !/[a-z][A-Z]/.test(core)) {
    return core[0].toUpperCase() + core.slice(1);
  }
  return core;
}

function applyCapitalizationPass(segments: Segment[]): void {
  let atSentenceStart = true;

  for (const seg of segments) {
    if (seg.kind === 'ws') {
      continue;
    }

    if (seg.kind === 'punct') {
      if (/[.!?]$/.test(seg.raw)) {
        atSentenceStart = true;
      }
      continue;
    }

    if (seg.kind === 'protected') {
      atSentenceStart = false;
      continue;
    }

    // seg.kind === 'word'
    let core = seg.core!;
    const iForm = STANDALONE_I_CONTRACTIONS.get(core.toLowerCase());
    if (iForm && core === core.toLowerCase()) {
      core = iForm;
    }

    if (atSentenceStart) {
      core = capitalizeSentenceStart(core);
      atSentenceStart = false;
    }

    seg.core = core;

    const trail = seg.trailPunct ?? '';
    if (/[.!?]/.test(trail) && !ABBREV_NO_SENTENCE_END.has(core.toLowerCase())) {
      atSentenceStart = true;
    }
  }
}

/**
 * Deterministic, zero-LLM local CPU keyboard typo fixer for fast all-lowercase typing.
 * Fixes finger transpositions, QWERTY fat-fingers, dropped-letter shortcuts, accidental
 * space splits, dictionary casing, standalone `i` -> `I`, and sentence-start capitalization
 * while preserving URLs, file paths, CLI flags, code identifiers, numbers, and proper names.
 */
export function fixKeyboardTypos(
  text: string,
  dictionaryEntries: DictionaryEntry[] = []
): string {
  if (!text || !text.trim()) return text;

  const dictIndex = buildDictionaryIndex(dictionaryEntries);
  let segments = tokenize(text);

  // 1. Multi-word dictionary phrase matching (e.g. "wisper flow" -> "Wisper Flow")
  segments = applyMultiWordDictionaryPass(segments, dictIndex);

  // 2. Accidental space splits & compound merges (e.g. "akey bvoard" -> "a keyboard", "auto sugess" -> "auto-suggest")
  segments = applySpaceSplitAndCompoundPass(segments, dictIndex);

  // 3. Single-word typo & dictionary resolution
  for (const seg of segments) {
    if (seg.kind === 'word' && seg.core) {
      seg.core = resolveWordCore(seg.core, dictIndex);
    }
  }

  // 4. Standalone `i` + sentence-start capitalization
  applyCapitalizationPass(segments);

  // 5. Reconstruct preserving exact whitespace and punctuation
  let result = '';
  for (const seg of segments) {
    if (seg.kind === 'word') {
      result += `${seg.leadPunct ?? ''}${seg.core ?? ''}${seg.trailPunct ?? ''}`;
    } else {
      result += seg.raw;
    }
  }
  return result;
}
