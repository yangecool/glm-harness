/**
 * Structured POSIX shell analysis for the GH permission gate: segment a
 * command into simple invocations with per-word facts, then decide against a
 * bounded dangerous-operation grammar and a conservative read-only table.
 *
 * The analyzer never expands anything and never treats an unparsed construct
 * as safe: anything it cannot represent marks the analysis `unsupported`,
 * which downstream modes read as "not proven read-only / no dangerous match
 * claim" (plan §6.1: 解析未知不得自动判安全). It is a risk tripwire in front
 * of the sandbox and approval chain, not a sandbox itself.
 *
 * @module @glm-harness/gh-permissions/analysis
 */

/** One segmented shell word with the literal facts the gate reads. */
export interface ShellWord {
  /** Quote/escape-processed literal content; expansion spans stay raw. */
  readonly value: string
  /** The word carries an expansion or unquoted glob/brace/tilde the analyzer cannot value. */
  readonly dynamic: boolean
  /** An unquoted `*?[` appeared, so the word may expand to several paths. */
  readonly hasUnquotedGlob: boolean
}

/** One simple-command segment after tokenization. */
export interface ShellSegment {
  readonly words: readonly ShellWord[]
  /** A `>`-family redirection targets a file in this segment. */
  readonly hasWriteRedirect: boolean
}

/** Aggregate tokenizer output for one command string. */
export interface ShellAnalysis {
  readonly segments: readonly ShellSegment[]
  /** Some construct was outside the represented grammar. */
  readonly unsupported: boolean
  /** Dangerous rule ids matched inside command/backtick substitutions. */
  readonly expansionRuleIds: readonly string[]
}

/** Option arity vocabulary of the bounded invocation grammar. */
type OptionArity = 'flag' | 'value' | 'optional'
/** Option name → arity; words the grammar claims to understand. */
type OptionTable = Readonly<Record<string, OptionArity>>

/** How one command's option words are scanned. */
interface OptionScanPolicy {
  /** Wrapper words stop at the first operand; command words interleave. */
  readonly ordering: 'stop-at-operand' | 'interspersed'
  /** Wrapper scanning aborts on unknown options; command scanning continues. */
  readonly unknown: 'abort' | 'continue'
}

const WRAPPER_SCAN: OptionScanPolicy = { ordering: 'stop-at-operand', unknown: 'abort' }
const COMMAND_SCAN: OptionScanPolicy = { ordering: 'interspersed', unknown: 'continue' }

/** Result of scanning words against one option table. */
interface ParsedOptions {
  readonly flags: readonly string[]
  readonly operands: readonly ShellWord[]
  readonly unsupported: boolean
}

const MAX_COMMAND_LENGTH = 10_000

/** Control-structure words stripped from a segment head before matching. */
const LEADING_KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'for', 'in', 'case', 'esac',
  '!', '{', '}', '(', ';', ';;',
])

/** Wrappers whose own options must be consumed before the real command name. */
const WRAPPERS = {
  env: optionTable('-i --ignore-environment -0 --null -v --debug', '-u --unset -C --chdir'),
  time: optionTable('-a --append -p --portability -v --verbose -q --quiet', '-o --output -f --format'),
  sudo: optionTable(
    '-A --askpass -b --background -E --preserve-env -H --set-home -K --remove-timestamp -k --reset-timestamp -n --non-interactive -S --stdin',
    '-u --user -g --group -h --host -p --prompt -C --close-from -T --command-timeout -D --chdir -R --chroot',
  ),
} as const

/**
 * Build one {@link OptionTable} from whitespace-separated name lists.
 * @param flags - zero-argument option names.
 * @param values - one-argument option names.
 * @param optional - options whose argument may be attached or absent.
 */
function optionTable(flags: string, values = '', optional = ''): OptionTable {
  return Object.fromEntries([
    ...flags.split(/\s+/).filter(Boolean).map(name => [name, 'flag'] as const),
    ...values.split(/\s+/).filter(Boolean).map(name => [name, 'value'] as const),
    ...optional.split(/\s+/).filter(Boolean).map(name => [name, 'optional'] as const),
  ])
}

/**
 * Scan words against a bounded option grammar. Unknown options never enter
 * `flags`; with the continue policy they only mark the scan `unsupported`, so
 * an already-recognized `-r`/`--delete` survives an unrelated trailing word.
 */
function parseOptions(words: readonly ShellWord[], table: OptionTable, policy: OptionScanPolicy): ParsedOptions {
  const flags: string[] = []
  const operands: ShellWord[] = []
  let unsupported = false
  let ended = false
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]
    if (word === undefined) continue
    if (!ended && !word.dynamic && word.value === '--') {
      ended = true
      continue
    }
    if (ended || word.dynamic || !word.value.startsWith('-') || word.value === '-') {
      operands.push(word)
      if (policy.ordering === 'stop-at-operand') {
        operands.push(...words.slice(i + 1))
        break
      }
      continue
    }
    const long = word.value.startsWith('--')
    const equals = word.value.indexOf('=')
    const names = long
      ? [equals < 0 ? word.value : word.value.slice(0, equals)]
      : Array.from(word.value.slice(1), char => `-${char}`)
    for (let n = 0; n < names.length; n += 1) {
      const name = names[n]
      if (name === undefined) continue
      const arity = table[name]
      const attached = long ? equals >= 0 : n < names.length - 1
      if (arity === undefined || (arity === 'flag' && long && attached)) {
        unsupported = true
        if (policy.unknown === 'abort') return { flags, operands, unsupported }
        continue
      }
      flags.push(name)
      if (arity === 'value' && !attached && words[++i] === undefined) unsupported = true
      if (arity !== 'flag') break
    }
  }
  return { flags, operands, unsupported }
}

/** Last-writer resolution of one switch group over the scanned flag order. */
function enabled(flags: readonly string[], yes: readonly string[], no: readonly string[] = []): boolean {
  let result = false
  for (const flag of flags) {
    if (yes.includes(flag)) result = true
    if (no.includes(flag)) result = false
  }
  return result
}

/** One matcher's outcome: a rule id, a proven non-match, or out-of-grammar. */
type RuleMatch = string | false | undefined

/** Match wins over uncertainty; only a clean grammar yields `false`. */
function settleRule(rule: string | false, parsed: Pick<ParsedOptions, 'unsupported'>): RuleMatch {
  return rule || (parsed.unsupported ? undefined : false)
}

/** Command name of one word, or undefined when the word is dynamic. */
function commandBasename(word: ShellWord): string | undefined {
  if (word.dynamic) return undefined
  return word.value.split('/').at(-1)
}

/**
 * Tokenize one command string into simple-command segments. The scanner
 * handles POSIX quoting/escapes, comments, `;`/newline/pipe segmentation,
 * redirections (skipping static heredoc bodies), and expansion spans. Spans
 * inside `$()`/backticks are recursively scanned for dangerous rules, because
 * they execute before the outer command.
 * @param source - the raw command string (`bash -c` payload).
 * @returns segments, the unsupported flag, and expansion findings.
 */
export function analyzePosixCommand(source: string): ShellAnalysis {
  const root = tokenize(source, 0)
  return { segments: root.segments, unsupported: root.unsupported, expansionRuleIds: [...root.expansionRuleIds] }
}

/** Mutable tokenizer state shared across the recursive expansion recursion. */
interface TokenizeResult {
  segments: ShellSegment[]
  unsupported: boolean
  expansionRuleIds: Set<string>
}

/** Deepest expansion nesting the analyzer will descend into. */
const MAX_EXPANSION_DEPTH = 4

function tokenize(source: string, depth: number): TokenizeResult {
  const result: TokenizeResult = { segments: [], unsupported: false, expansionRuleIds: new Set() }
  const words: { value: string; dynamic: boolean; hasUnquotedGlob: boolean }[] = []
  let hasWriteRedirect = false
  let word: { value: string; dynamic: boolean; hasUnquotedGlob: boolean } | undefined
  let quote = ''
  let i = 0

  const ensureWord = () => {
    word ??= { value: '', dynamic: false, hasUnquotedGlob: false }
    return word
  }
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) result.segments.push({ words: [...words], hasWriteRedirect })
    words.length = 0
    hasWriteRedirect = false
  }

  while (i < source.length) {
    const char = source[i]
    if (char === undefined) break
    if (quote === '\'') {
      if (char === '\'') quote = ''
      else ensureWord().value += char
      i += 1
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = ''
        i += 1
        continue
      }
      if (char === '\\') {
        const next = source[i + 1]
        if (next === undefined) {
          ensureWord().dynamic = true
        } else if (['$', '`', '"', '\\', '\n'].includes(next)) {
          if (next !== '\n') ensureWord().value += next
          i += 1
        } else ensureWord().value += char
        i += 1
        continue
      }
      if (char === '$' || char === '`') {
        ensureWord().dynamic = true
        const scan = char === '$' && source[i + 1] === '('
          ? scanExpansion(source, i, 'paren', depth, result)
          : char === '`'
            ? scanExpansion(source, i, 'backtick', depth, result)
            : undefined
        if (scan !== undefined) {
          ensureWord().value += source.slice(i, scan.end + 1)
          i = scan.end + 1
          continue
        }
      }
      ensureWord().value += char
      i += 1
      continue
    }
    // Unquoted context.
    if (char === '\\') {
      const next = source[i + 1]
      if (next === undefined) ensureWord().dynamic = true
      else if (next === '\n') i += 1
      else {
        ensureWord().value += next
        i += 1
      }
      i += 1
      continue
    }
    if (char === '\'' || char === '"') {
      quote = char
      ensureWord()
      i += 1
      continue
    }
    if (char === '#' && word === undefined) {
      const newline = source.indexOf('\n', i)
      i = newline < 0 ? source.length : newline
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      endWord()
      i += 1
      continue
    }
    if (char === '\n' || char === ';') {
      endSegment()
      i += source[i + 1] === ';' ? 2 : 1
      continue
    }
    if (char === '&' || char === '|') {
      if (char === '&' && source[i + 1] === '>') {
        // `&>`/`&>>` redirect both streams to a file: redirection, not backgrounding.
        const scan = scanRedirection(source, i, word, result)
        if (scan.write) hasWriteRedirect = true
        if (scan.discardPrefix) word = undefined
        i = scan.next
        continue
      }
      if (char === '&') result.unsupported = true
      endSegment()
      const next = source[i + 1]
      i += next === char || (char === '|' && next === '&') ? 2 : 1
      continue
    }
    if (char === '(' || char === ')') {
      // Group/subshell/function markers: outside the represented grammar, but
      // segmentation continues so bodies still reach the matchers.
      ensureWord().dynamic = true
      ensureWord().value += char
      result.unsupported = true
      i += 1
      continue
    }
    if (char === '<' || char === '>') {
      const scan = scanRedirection(source, i, word, result)
      if (scan.write) hasWriteRedirect = true
      if (scan.discardPrefix) word = undefined
      i = scan.next
      continue
    }
    if (char === '$') {
      ensureWord().dynamic = true
      if (source[i + 1] === '(' || source[i + 1] === '{') {
        const closing = source[i + 1] === '(' ? 'paren' : 'brace'
        const scan = scanExpansion(source, i, closing, depth, result)
        ensureWord().value += source.slice(i, scan.end + 1)
        i = scan.end + 1
        continue
      }
      ensureWord().value += char
      i += 1
      continue
    }
    if (char === '`') {
      ensureWord().dynamic = true
      const scan = scanExpansion(source, i, 'backtick', depth, result)
      ensureWord().value += source.slice(i, scan.end + 1)
      i = scan.end + 1
      continue
    }
    const current = ensureWord()
    if ('*?['.includes(char)) {
      current.dynamic = true
      current.hasUnquotedGlob = true
    } else if ('{}~'.includes(char)) current.dynamic = true
    current.value += char
    i += 1
  }
  if (quote !== '') result.unsupported = true
  endSegment()
  return result
}

/** Locate the end of one expansion span and record its dangerous findings. */
function scanExpansion(
  source: string,
  start: number,
  kind: 'paren' | 'brace' | 'backtick',
  depth: number,
  result: TokenizeResult,
): { end: number } {
  if (kind === 'brace') {
    const close = source.indexOf('}', start + 2)
    if (close < 0) {
      result.unsupported = true
      return { end: source.length - 1 }
    }
    return { end: close }
  }
  if (kind === 'backtick') {
    let i = start + 1
    while (i < source.length) {
      const char = source[i]
      if (char === '\\') i += 2
      else if (char === '`') break
      else i += 1
    }
    if (i >= source.length) {
      result.unsupported = true
      return { end: source.length - 1 }
    }
    recordExpansionFindings(source.slice(start + 1, i), depth, result)
    return { end: i }
  }
  // $( ... ): depth-aware scan respecting quotes so a ')' inside quotes ends nothing.
  let nesting = 0
  let quote = ''
  let i = start
  while (i < source.length) {
    const char = source[i]
    if (quote !== '') {
      if (char === quote) quote = ''
      else if (char === '\\' && quote === '"') i += 1
      i += 1
      continue
    }
    if (char === '\'' || char === '"') quote = char
    else if (char === '(') nesting += 1
    else if (char === ')') {
      nesting -= 1
      if (nesting === 0) {
        recordExpansionFindings(source.slice(start + 2, i), depth, result)
        return { end: i }
      }
    }
    i += 1
  }
  result.unsupported = true
  return { end: source.length - 1 }
}

/** Recursively scan one expansion payload for dangerous rules, depth-capped. */
function recordExpansionFindings(payload: string, depth: number, result: TokenizeResult): void {
  if (depth >= MAX_EXPANSION_DEPTH || payload.length > MAX_COMMAND_LENGTH) {
    result.unsupported = true
    return
  }
  const inner = tokenize(payload, depth + 1)
  result.unsupported = result.unsupported || inner.unsupported
  for (const ruleId of inner.expansionRuleIds) result.expansionRuleIds.add(ruleId)
  for (const segment of inner.segments) {
    const match = matchSegmentRules(segment)
    if (match.status === 'matched') result.expansionRuleIds.add(match.ruleId)
  }
}

/** One scanned redirection: its end offset, write flag, and fd-prefix discard. */
interface RedirectionScan {
  readonly next: number
  readonly write: boolean
  readonly discardPrefix: boolean
}

/**
 * Consume one redirection operator plus its target word. Heredocs skip the
 * body lines so their contents never become tokens; a dynamic heredoc
 * delimiter or a missing one marks the scan unsupported.
 */
function scanRedirection(source: string, start: number, fdWord: unknown, result: TokenizeResult): RedirectionScan {
  const discardPrefix = typeof fdWord === 'object' && fdWord !== null
    && 'value' in fdWord && /^\d*$/.test((fdWord as { value: string }).value)
    && (fdWord as { value: string }).value !== ''
  let i = start
  let operator = ''
  while (i < source.length) {
    const op = source[i]
    if (op === undefined || !'<>'.includes(op)) break
    operator += op
    i += 1
  }
  const fdDuplication = operator === '>&' || operator === '<&'
  if (operator.includes('<<') && operator !== '<<<') {
    // Heredoc: read the delimiter word, then skip until its matching line.
    while (i < source.length && /[ \t]/.test(source[i] ?? '')) i += 1
    let delimiter = ''
    let dynamicDelimiter = false
    let quote = ''
    while (i < source.length) {
      const char = source[i]
      if (char === undefined) break
      if (quote !== '') {
        if (char === quote) quote = ''
        else delimiter += char
      } else if (char === '"' || char === '\'') quote = char
      else if (/[ \t\n]/.test(char)) break
      else if ('$`'.includes(char)) {
        dynamicDelimiter = true
        delimiter += char
      } else delimiter += char
      i += 1
    }
    if (dynamicDelimiter || delimiter === '') {
      result.unsupported = true
      return { next: i, write: false, discardPrefix }
    }
    const stripTabs = operator.includes('<<-')
    if (i < source.length && source[i] !== '\n') {
      // Words on the same line after the delimiter are not part of any heredoc grammar we claim.
      result.unsupported = true
    }
    let lineStart = source.indexOf('\n', i)
    while (lineStart >= 0) {
      const nextBreak = source.indexOf('\n', lineStart + 1)
      const lineEnd = nextBreak < 0 ? source.length : nextBreak
      const line = source.slice(lineStart + 1, lineEnd)
      const candidate = stripTabs ? line.replace(/^\t+/, '') : line
      if (candidate === delimiter) return { next: lineEnd, write: false, discardPrefix }
      lineStart = nextBreak
    }
    result.unsupported = true
    return { next: source.length, write: false, discardPrefix }
  }
  // Absorb the target word so it never joins the invocation's operands.
  while (i < source.length && /[ \t]/.test(source[i] ?? '')) i += 1
  let quote = ''
  while (i < source.length) {
    const char = source[i]
    if (char === undefined) break
    if (quote !== '') {
      if (char === quote) quote = ''
      i += 1
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      i += 1
      continue
    }
    if (char === '\\') i += 1
    else if (/[ \t\n;<>&|]/.test(char)) break
    i += 1
  }
  const target = source.slice(start, i)
  const write = operator.includes('>')
    && !(fdDuplication && />&\s*\d+\s*$/.test(target))
  return { next: i, write, discardPrefix }
}

/** Strip leading control keywords, env assignments, and known wrappers. */
function invocationWords(segment: ShellSegment): readonly ShellWord[] | undefined {
  let words = segment.words
  while (words.length > 0) {
    const first = words[0]
    if (first === undefined) break
    if (!first.dynamic && LEADING_KEYWORDS.has(first.value)) {
      words = words.slice(1)
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first.value)) {
      words = words.slice(1)
      continue
    }
    const name = commandBasename(first)
    if (name === undefined) return undefined
    if (!(name in WRAPPERS)) return words
    const parsed = parseOptions(words.slice(1), WRAPPERS[name as keyof typeof WRAPPERS], WRAPPER_SCAN)
    if (parsed.unsupported) return undefined
    words = parsed.operands
    if (name === 'env' || name === 'sudo') {
      while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value)) words = words.slice(1)
    }
  }
  return words.length > 0 ? words : []
}

/** rm's option grammar. */
const RM = optionTable(
  '-r -R --recursive -f --force -i -I --one-file-system --preserve-root --no-preserve-root -v --verbose -d --dir --help --version',
  '',
  '--interactive',
)
/** rsync's deletion-bearing options. */
const RSYNC_DELETE = ['--delete', '--del', '--delete-before', '--delete-during', '--delete-delay', '--delete-after', '--delete-excluded']
/** rsync's option grammar. */
const RSYNC = optionTable(
  `-a -r -v -q -z -h -P -p -t -g -o -D -l -H -A -X -u -c -n --dry-run --archive --recursive --verbose --quiet --compress --progress --partial --checksum --update --numeric-ids --ignore-errors --force --help --version ${RSYNC_DELETE.join(' ')}`,
  '-e --rsh -f --filter --include --exclude --include-from --exclude-from --files-from --rsync-path --log-file --out-format --backup-dir --suffix --chmod --chown --max-delete --timeout --bwlimit --compare-dest --copy-dest --link-dest',
)
/** Shells whose `-c` payload is itself a shell command string. */
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'eval'])
/** git's leading option grammar (wrapper-position semantics). */
const GIT_FRONT = optionTable(
  '--no-pager -P --paginate -p --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --bare --no-replace-objects --no-optional-locks',
  '-C --git-dir --work-tree --namespace -c --config-env --super-prefix',
  '--exec-path',
)
const GIT_HELP = '-h --help'
const GIT_COMMON = `${GIT_HELP} -q --quiet -v --verbose`
const GIT_RESET = optionTable(`${GIT_COMMON} --hard --soft --mixed --merge --keep -p --patch -N --intent-to-add --no-refresh --refresh --recurse-submodules --no-recurse-submodules`)
const GIT_CLEAN = optionTable(`${GIT_COMMON} -f --force -d -x -X -n --dry-run --no-dry-run -i --interactive`, '-e --exclude')
const GIT_PUSH = optionTable(
  `${GIT_COMMON} -f --force --no-force --mirror --no-mirror -n --dry-run --no-dry-run --no-force-with-lease --force-if-includes --no-force-if-includes --all --branches --tags --delete -d --prune --atomic --no-atomic --porcelain --follow-tags --no-follow-tags --set-upstream -u --thin --no-thin --progress --no-progress --ipv4 -4 --ipv6 -6`,
  '--repo --receive-pack --exec -o --push-option',
  '--force-with-lease --signed --recurse-submodules',
)
const GIT_CHECKOUT = optionTable(
  `${GIT_COMMON} -f --force --no-force --detach --ours --theirs -m --merge --conflict -p --patch --ignore-other-worktrees --recurse-submodules --no-recurse-submodules --no-overlay --overlay`,
  '-b -B --orphan --conflict',
)
const GIT_RESTORE = optionTable(
  `${GIT_COMMON} -W --worktree --no-worktree -S --staged --no-staged --ours --theirs -m --merge -p --patch --ignore-unmerged --overlay --no-overlay --recurse-submodules --no-recurse-submodules`,
  '-s --source --conflict',
)
const GIT_FORCE = ['-f', '--force']
const GIT_TREE = new Set(['.', './', ':/'])
/** find's no-argument predicates. */
const FIND_FLAGS = new Set('-H -L -P -O0 -O1 -O2 -O3 -depth -d -x -xdev -mount -ignore_readdir_race -noignore_readdir_race -daystart -follow -noleaf -true -false -empty -readable -writable -executable -print -print0 -ls -prune -quit -a -and -o -or -not ! ( ) ,'.split(' '))
/** find's one-argument predicates. */
const FIND_VALUES = new Set('-D -f -name -iname -path -ipath -wholename -iwholename -regex -iregex -regextype -type -xtype -size -user -group -uid -gid -perm -links -inum -samefile -newer -anewer -cnewer -atime -ctime -mtime -amin -cmin -mmin -used -maxdepth -mindepth -printf -fprint -fprint0 -fls -files0-from'.split(' '))
/** find's action predicates that execute or delete. */
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

function gitHasHelp(flags: readonly string[]): boolean {
  return flags.includes('--help') || flags.includes('-h')
}

/** git's bounded dangerous subcommand grammar. */
function matchGit(words: readonly ShellWord[]): RuleMatch {
  const front = parseOptions(words, GIT_FRONT, WRAPPER_SCAN)
  if (front.unsupported || front.operands[0]?.dynamic) return undefined
  const [head, ...args] = front.operands
  if (head === undefined) return false
  let table: OptionTable | undefined
  switch (head.value) {
    case 'reset': table = GIT_RESET; break
    case 'clean': table = GIT_CLEAN; break
    case 'push': table = GIT_PUSH; break
    case 'checkout': table = GIT_CHECKOUT; break
    case 'restore': table = GIT_RESTORE; break
    case 'stash': {
      if (args[0]?.dynamic) return undefined
      if (args[0]?.value !== 'clear') return false
      const parsed = parseOptions(args.slice(1), optionTable(GIT_HELP), COMMAND_SCAN)
      return settleRule(!gitHasHelp(parsed.flags) && 'git-stash-clear', parsed)
    }
    case 'worktree': {
      if (args[0]?.dynamic) return undefined
      if (args[0]?.value !== 'remove') return false
      const parsed = parseOptions(args.slice(1), optionTable(`${GIT_HELP} -f --force --no-force`), COMMAND_SCAN)
      return settleRule(!gitHasHelp(parsed.flags) && enabled(parsed.flags, GIT_FORCE, ['--no-force']) && 'git-worktree-force-remove', parsed)
    }
    default: return undefined
  }
  const parsed = parseOptions(args, table, COMMAND_SCAN)
  const { flags, operands } = parsed
  if (gitHasHelp(flags)) return false
  const dryRun = enabled(flags, ['-n', '--dry-run'], ['--no-dry-run'])
  const force = enabled(flags, GIT_FORCE, ['--no-force'])
  switch (head.value) {
    case 'reset':
      return settleRule(enabled(flags, ['--hard'], ['--soft', '--mixed', '--merge', '--keep', '-p', '--patch']) && 'git-reset-hard', parsed)
    case 'clean':
      return settleRule(!dryRun && force && 'git-clean-force', parsed)
    case 'push': {
      const refspecs = flags.includes('--repo') ? operands : operands.slice(1)
      return settleRule(
        !dryRun && (force
          || enabled(flags, ['--force-with-lease'], ['--no-force-with-lease'])
          || enabled(flags, ['--mirror'], ['--no-mirror'])
          || refspecs.some(word => !word.dynamic && word.value.startsWith('+')))
          && 'git-push-force',
        parsed,
      )
    }
    case 'checkout':
      return settleRule((force || operands.some(word => !word.dynamic && GIT_TREE.has(word.value))) && 'git-discard-tree', parsed)
    case 'restore': {
      const stagedOnly = enabled(flags, ['-S', '--staged'], ['--no-staged'])
        && !enabled(flags, ['-W', '--worktree'], ['--no-worktree'])
      return settleRule(!stagedOnly && operands.some(word => !word.dynamic && GIT_TREE.has(word.value)) && 'git-discard-tree', parsed)
    }
    default: return false
  }
}

/** find's bounded delete/exec grammar, including the `-exec` payload words. */
function matchFind(args: readonly ShellWord[]): RuleMatch {
  let expression = false
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i]
    if (word === undefined) continue
    const value = word.value
    if (!expression && !value.startsWith('-') && !['!', '('].includes(value)) continue
    if (word.dynamic) return undefined
    if (['-H', '-L', '-P', '-O0', '-O1', '-O2', '-O3', '-d', '-x'].includes(value) && !expression) continue
    if (['-D', '-f'].includes(value) && !expression) {
      if (args[++i] === undefined) return undefined
      continue
    }
    expression = true
    if (value === '-delete') return 'find-delete'
    if (FIND_EXEC.has(value)) {
      const payload: ShellWord[] = []
      let closed = false
      while (++i < args.length) {
        const token = args[i]
        if (token === undefined) break
        if (!token.dynamic && (token.value === ';' || (token.value === '+' && args[i - 1]?.value === '{}' && ['-exec', '-execdir'].includes(value)))) {
          closed = true
          break
        }
        payload.push(token)
      }
      if (!closed) return undefined
      // The payload is a command find executes per match: analyze it too.
      if (payload.length > 0) {
        const payloadMatch = matchInvocationWords(payload)
        if (payloadMatch !== false) return payloadMatch
      }
    } else if (value === '-fprintf') {
      i += 2
      if (args[i] === undefined) return undefined
    } else if (FIND_VALUES.has(value) || /^-newer[acmBt][acmBt]$/.test(value)) {
      i += 1
      if (args[i] === undefined) return undefined
    } else if (!FIND_FLAGS.has(value)) return undefined
  }
  return false
}

/** One dangerous-grammar outcome for a whole command string. */
export type DangerousMatch =
  | { status: 'matched'; ruleId: string; origin: 'invocation' | 'expansion' | 'interpreter-payload' }
  | { status: 'notMatched' }
  | { status: 'unsupported' }

/** Apply the dangerous grammar to one already-tokenized segment. */
function matchSegmentRules(segment: ShellSegment): DangerousMatch {
  const words = invocationWords(segment)
  if (words === undefined) return { status: 'unsupported' }
  if (words.length === 0) return { status: 'notMatched' }
  const match = matchInvocationWords(words)
  if (match === undefined) return { status: 'unsupported' }
  if (match === false) return { status: 'notMatched' }
  return { status: 'matched', ruleId: match, origin: 'invocation' }
}

/** Apply the dangerous grammar to one invocation's name+argument words. */
function matchInvocationWords(words: readonly ShellWord[]): RuleMatch {
  const first = words[0]
  if (first === undefined) return false
  const name = commandBasename(first)
  if (name === undefined) return undefined
  const args = words.slice(1)
  if (name === 'git') return matchGit(args)
  if (SHELL_INTERPRETERS.has(name)) {
    // A shell's -c payload is a command string: analyze it instead of skipping.
    const flagIndex = args.findIndex(word => !word.dynamic && word.value === '-c')
    const payload = flagIndex >= 0 ? args[flagIndex + 1] : undefined
    if (payload !== undefined && !payload.dynamic) {
      const inner = matchDangerousText(payload.value)
      if (inner.status === 'matched') return inner.ruleId
    }
    return undefined
  }
  if (name === 'find') return matchFind(args)
  if (name === 'rm') {
    const parsed = parseOptions(args, RM, COMMAND_SCAN)
    const targets = parseOptions(args, RM, { ordering: 'stop-at-operand', unknown: 'continue' })
    return settleRule(
      (enabled(parsed.flags, ['-r', '-R', '--recursive'])
        || targets.operands.length >= 2
        || targets.operands.some(word => word.hasUnquotedGlob))
        && 'remove-critical-path',
      parsed,
    )
  }
  if (name === 'dd' || name === 'mount' || name === 'umount' || name === 'mkfs' || /^mkfs\.[a-zA-Z0-9_-]+$/.test(name)) {
    if (args.length === 1 && !args[0]?.dynamic && ['--help', '--version'].includes(args[0]?.value ?? '')) return false
    return !(name === 'mount' && args.length === 0) && 'system-storage'
  }
  if (name === 'rsync') {
    const parsed = parseOptions(args, RSYNC, COMMAND_SCAN)
    return settleRule(
      !parsed.flags.some(flag => ['-n', '--dry-run', '--help', '--version'].includes(flag))
        && parsed.flags.some(flag => RSYNC_DELETE.includes(flag))
        && 'rsync-delete',
      parsed,
    )
  }
  return false
}

/**
 * Run the dangerous-operation grammar over one command string, including
 * command/backtick substitution payloads.
 * @param command - the raw shell command.
 * @returns the aggregate match outcome.
 */
export function matchDangerousText(command: string): DangerousMatch {
  if (command.length > MAX_COMMAND_LENGTH) return { status: 'unsupported' }
  const analysis = analyzePosixCommand(command)
  if (analysis.expansionRuleIds.length > 0) {
    const ruleId = analysis.expansionRuleIds[0]
    if (ruleId !== undefined) return { status: 'matched', ruleId, origin: 'expansion' }
  }
  let unsupported = analysis.unsupported
  for (const segment of analysis.segments) {
    const match = matchSegmentRules(segment)
    if (match.status === 'matched') return { status: 'matched', ruleId: match.ruleId, origin: 'invocation' }
    if (match.status === 'unsupported') unsupported = true
  }
  return unsupported ? { status: 'unsupported' } : { status: 'notMatched' }
}

/** Search/list commands that never modify state regardless of argument values. */
const READONLY_SEARCH = new Set(['ag', 'ack', 'egrep', 'fgrep', 'grep', 'locate', 'rg', 'which', 'whereis'])
/** Text/file readers that never modify state by themselves. */
const READONLY_READ = new Set(['cat', 'cut', 'file', 'head', 'jq', 'less', 'more', 'sort', 'stat', 'strings', 'tail', 'tr', 'uniq', 'wc', 'yq'])
/** Directory/size listings. */
const READONLY_LIST = new Set(['du', 'ls', 'tree'])
/** Commands with no observable effect on any file or process. */
const READONLY_NEUTRAL = new Set(['', ':', 'echo', 'false', 'printf', 'true'])
/** git subcommands that only read. */
const GIT_READONLY = new Set(['status', 'log', 'diff', 'show', 'blame', 'describe', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'shortlog', 'whatchanged'])
/** Listing-only flags for git's branch/tag/remote listings. */
const GIT_LISTING_FLAGS = new Set(['-v', '--verbose', '-a', '--all', '-l', '--list', '-r', '--remotes', '--show-current', '--no-color'])

/** Whether one segment's invocation is proven read-only; conservative otherwise. */
function segmentIsReadOnly(segment: ShellSegment): boolean {
  if (segment.hasWriteRedirect) return false
  const words = invocationWords(segment)
  if (words === undefined || words.length === 0) return true
  const first = words[0]
  if (first === undefined) return true
  const name = commandBasename(first)
  if (name === undefined) return false
  const args = words.slice(1)
  if (name === 'sed') {
    const parsed = parseOptions(args, optionTable('-n --quiet --silent -e --expression -f --file --help --version', '-i --in-place --separate --follow-symlinks -s --sandbox'), COMMAND_SCAN)
    return !parsed.flags.some(flag => ['-i', '--in-place'].includes(flag))
  }
  if (name === 'find') {
    // The dangerous grammar already ran for the whole command; a find that
    // reaches here carried no -delete/-exec, but unknown predicates still
    // withhold the read-only claim.
    return matchFind(args) === false
  }
  if (name === 'git') {
    const front = parseOptions(args, GIT_FRONT, WRAPPER_SCAN)
    if (front.unsupported) return false
    const [head, ...rest] = front.operands
    if (head === undefined || head.dynamic) return false
    if (GIT_READONLY.has(head.value)) {
      // Every subcommand in this set only reads refs/objects; flags and refs
      // cannot turn status/log/diff/show/blame/ls-*/cat-file/rev-* into writes.
      return true
    }
    if (head.value === 'branch' || head.value === 'tag' || head.value === 'remote') {
      return rest.every(word => !word.dynamic && GIT_LISTING_FLAGS.has(word.value))
    }
    if (head.value === 'config') {
      const flagsOnly = rest.filter(word => word.value.startsWith('-'))
      const reads = flagsOnly.filter(word => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(word.value))
      return flagsOnly.length > 0 && flagsOnly.length === reads.length
    }
    if (head.value === 'reflog') {
      return rest.length === 0 || (rest.length === 1 && !rest[0]?.dynamic && rest[0]?.value === 'show')
    }
    return false
  }
  return READONLY_SEARCH.has(name) || READONLY_READ.has(name) || READONLY_LIST.has(name) || READONLY_NEUTRAL.has(name)
}

/**
 * Whether a whole command string is proven read-only: every segment reads,
 * nothing writes through a redirection, and no dangerous rule matched.
 * Unknown commands and unparsed constructs are NOT read-only.
 * @param command - the raw shell command.
 * @returns whether every segment is proven read-only.
 */
export function isReadOnlyPosixCommand(command: string): boolean {
  if (command.trim().length === 0) return true
  if (command.length > MAX_COMMAND_LENGTH) return false
  if (matchDangerousText(command).status === 'matched') return false
  const analysis = analyzePosixCommand(command)
  if (analysis.segments.length === 0) return !analysis.unsupported
  return analysis.segments.every(segmentIsReadOnly)
}
