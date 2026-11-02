// Small hand-written syntax highlighters. Output is built only from text nodes and spans,
// so transcript content can never inject markup into the page.

export const SIZE_LIMIT = 150000;

const EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  py: 'python', pyw: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', bat: 'shell', cmd: 'shell', ps1: 'shell',
  json: 'json', jsonl: 'json', jsonc: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  diff: 'diff', patch: 'diff',
};

export function languageForPath(path) {
  if (!path) return '';
  const m = /\.([a-z0-9]+)$/i.exec(path);
  if (!m) return /(^|[\\/])(Dockerfile|Makefile)$/.test(path) ? 'shell' : '';
  return EXT[m[1].toLowerCase()] || '';
}

export function normalizeLanguage(tag) {
  if (!tag) return '';
  const t = tag.toLowerCase().trim();
  const map = {
    js: 'javascript', javascript: 'javascript', jsx: 'javascript', node: 'javascript',
    ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
    py: 'python', python: 'python', python3: 'python',
    sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', console: 'shell', powershell: 'shell', ps: 'shell', bat: 'shell',
    json: 'json', jsonc: 'json', jsonl: 'json',
    css: 'css', scss: 'css',
    html: 'html', xml: 'html', svg: 'html', vue: 'html',
    md: 'markdown', markdown: 'markdown',
    diff: 'diff', patch: 'diff',
  };
  return map[t] || '';
}

export function guessLanguage(text) {
  const head = text.slice(0, 4000).trimStart();
  if (!head) return '';
  if (/^[{[]/.test(head)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      /* not json */
    }
  }
  if (/^(diff --git|---\s|\+\+\+\s|@@ )/m.test(head) && /^[+-]/m.test(head)) return 'diff';
  if (/^<!doctype html|^<html|^<\?xml|^<[a-z][^>]*>/i.test(head)) return 'html';
  if (/^#!.*\b(bash|sh|zsh)\b/.test(head) || /^\$ /m.test(head)) return 'shell';
  if (/^#!.*python|^(def|class|import|from)\s+\w+/m.test(head)) return 'python';
  if (/^(import|export)\s|\b(const|let|function)\s+\w+|=>/.test(head)) return /:\s*(string|number|boolean)\b|\binterface\s+\w+/.test(head) ? 'typescript' : 'javascript';
  if (/^#{1,6}\s|^\s*[-*]\s|```/m.test(head)) return 'markdown';
  if (/^[.#@a-z][^{]*\{[^}]*:[^}]*\}/m.test(head)) return 'css';
  return '';
}

// ---- Generic rule-based tokenizer --------------------------------------------

function tokenize(text, rules) {
  const out = [];
  let i = 0;
  let plain = '';
  const n = text.length;
  while (i < n) {
    let matched = false;
    for (const [re, cls] of rules) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m.index === i && m[0].length) {
        if (plain) {
          out.push(['', plain]);
          plain = '';
        }
        out.push([cls, m[0]]);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      plain += text[i++];
    }
  }
  if (plain) out.push(['', plain]);
  return out;
}

const sticky = (src, flags = '') => new RegExp(src, flags + 'y');

const JS_KW = 'break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|return|super|switch|this|throw|try|typeof|var|void|while|with|yield|await|async|of|static|get|set|from|as';
const TS_KW = JS_KW + '|interface|type|enum|implements|declare|namespace|public|private|protected|readonly|abstract|keyof|infer|is|satisfies';
const jsRules = (kw) => [
  [sticky('\\/\\/[^\\n]*'), 'cm'],
  [sticky('\\/\\*[\\s\\S]*?\\*\\/'), 'cm'],
  [sticky('`(?:\\\\[\\s\\S]|\\$\\{[^}]*\\}|[^`\\\\])*`'), 'st'],
  [sticky('"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\''), 'st'],
  [sticky('\\/(?![*\\/])(?:\\\\.|\\[(?:\\\\.|[^\\]])*\\]|[^\\/\\\\\\n])+\\/[gimsuyd]*(?=[\\s,;.)\\]}]|$)'), 'st'],
  [sticky('\\b(?:' + kw + ')\\b'), 'kw'],
  [sticky('\\b(?:true|false|null|undefined|NaN|Infinity)\\b'), 'lit'],
  [sticky('\\b0[xX][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?n?\\b'), 'num'],
  [sticky('[A-Za-z_$][\\w$]*(?=\\s*\\()'), 'fn'],
  [sticky('[=!<>+\\-*/%&|^~?:]+'), 'op'],
];
const RULES = {
  javascript: jsRules(JS_KW),
  typescript: jsRules(TS_KW),
  python: [
    [sticky('#[^\\n]*'), 'cm'],
    [sticky('(?:[rRbBuUfF]{0,2})(?:"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\')'), 'st'],
    [sticky('(?:[rRbBuUfF]{0,2})(?:"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')'), 'st'],
    [sticky('\\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case)\\b'), 'kw'],
    [sticky('\\b(?:True|False|None|self|cls)\\b'), 'lit'],
    [sticky('@[\\w.]+'), 'attr'],
    [sticky('\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?j?\\b|\\b0[xXoObB][\\da-fA-F_]+\\b'), 'num'],
    [sticky('[A-Za-z_][\\w]*(?=\\s*\\()'), 'fn'],
    [sticky('[=!<>+\\-*/%&|^~@:]+'), 'op'],
  ],
  shell: [
    [sticky('#[^\\n]*'), 'cm'],
    [sticky('"(?:\\\\.|[^"\\\\])*"'), 'st'],
    [sticky('\'[^\']*\''), 'st'],
    [sticky('\\$(?:\\{[^}]*\\}|\\([^)]*\\)|[\\w@#?$!*-]+)'), 'var'],
    [sticky('(?<=^|[\\s;|&(])(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|time|return|exit|export|local|set|unset|source|readonly|declare|shift|trap|eval|exec)(?=[\\s;|&)]|$)'), 'kw'],
    [sticky('(?<=^|[\\s;|&(]|\\$\\()(?:cd|ls|cat|echo|grep|rg|sed|awk|find|xargs|sort|uniq|head|tail|wc|cut|tr|mkdir|rm|cp|mv|touch|chmod|chown|curl|wget|git|npm|npx|node|python3?|pip|docker|make|tar|zip|unzip|ssh|scp|kill|ps|sleep|test|printf|tee|which|env|diff|patch|ffmpeg|ffprobe|jq|yq|dirname|basename|realpath|readlink|true|false|pwd|date|bash|sh)(?=[\\s;|&)]|$)'), 'fn'],
    [sticky('(?<=\\s|^)--?[\\w-]+'), 'attr'],
    [sticky('\\b\\d+\\b'), 'num'],
    [sticky('[|&;<>()]+|\\\\\\n'), 'op'],
  ],
  json: [
    [sticky('"(?:\\\\.|[^"\\\\])*"(?=\\s*:)'), 'attr'],
    [sticky('"(?:\\\\.|[^"\\\\])*"'), 'st'],
    [sticky('\\b(?:true|false|null)\\b'), 'lit'],
    [sticky('-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b'), 'num'],
    [sticky('[{}\\[\\]:,]'), 'op'],
  ],
  css: [
    [sticky('\\/\\*[\\s\\S]*?\\*\\/'), 'cm'],
    [sticky('"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\''), 'st'],
    [sticky('@[\\w-]+'), 'kw'],
    [sticky('--[\\w-]+'), 'var'],
    [sticky('#[0-9a-fA-F]{3,8}\\b'), 'num'],
    [sticky('-?\\b\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch|vmin|vmax)?\\b'), 'num'],
    [sticky('[\\w-]+(?=\\s*:)'), 'attr'],
    [sticky('(?:[.#]?[\\w-]+|::?[\\w-]+(?:\\([^)]*\\))?|\\[[^\\]]*\\]|[*>+~])(?=[^{};]*\\{)'), 'fn'],
    [sticky('[{}:;,]'), 'op'],
  ],
  diff: [],
  markdown: [],
  html: [],
};

function htmlTokens(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  const push = (cls, s) => s && out.push([cls, s]);
  while (i < n) {
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i);
      const end = e === -1 ? n : e + 3;
      push('cm', text.slice(i, end));
      i = end;
      continue;
    }
    if (text[i] === '<' && /[a-zA-Z!/?]/.test(text[i + 1] || '')) {
      const e = text.indexOf('>', i);
      const end = e === -1 ? n : e + 1;
      const tag = text.slice(i, end);
      const m = /^<\/?\s*([\w:-]+)/.exec(tag);
      const name = m ? m[1].toLowerCase() : '';
      // tag tokens
      const inner = tokenize(tag, [
        [sticky('<\\/?\\s*[\\w:-]+|\\/?>'), 'kw'],
        [sticky('"[^"]*"|\'[^\']*\''), 'st'],
        [sticky('[\\w:.-]+(?==)'), 'attr'],
        [sticky('='), 'op'],
      ]);
      out.push(...inner);
      i = end;
      if ((name === 'script' || name === 'style') && !tag.startsWith('</')) {
        const closeRe = new RegExp('</' + name + '\\s*>', 'ig');
        closeRe.lastIndex = i;
        const cm = closeRe.exec(text);
        const bodyEnd = cm ? cm.index : n;
        const body = text.slice(i, bodyEnd);
        out.push(...tokenize(body, name === 'script' ? RULES.javascript : RULES.css));
        i = bodyEnd;
      }
      continue;
    }
    let j = text.indexOf('<', i + 1);
    if (j === -1) j = n;
    push('', text.slice(i, j));
    i = j;
  }
  return out;
}

function diffTokens(text) {
  const out = [];
  for (const line of text.split(/(?<=\n)/)) {
    if (/^(\+\+\+|---)\s/.test(line)) out.push(['meta', line]);
    else if (line.startsWith('@@')) out.push(['kw', line]);
    else if (line.startsWith('+')) out.push(['add', line]);
    else if (line.startsWith('-')) out.push(['del', line]);
    else if (/^(diff|index|rename|new file|deleted file)/.test(line)) out.push(['cm', line]);
    else out.push(['', line]);
  }
  return out;
}

const MD_INLINE = [
  [sticky('`[^`\\n]+`'), 'code'],
  [sticky('\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__'), 'b'],
  [sticky('(?<![\\w*])\\*[^*\\n]+\\*(?![\\w*])|(?<![\\w_])_[^_\\n]+_(?![\\w_])'), 'i'],
  [sticky('!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)'), 'link'],
  [sticky('<[^>\\n]+>'), 'tag'],
  [sticky('https?:\\/\\/[^\\s<>)]+'), 'link'],
];

function markdownTokens(text) {
  const out = [];
  const lines = text.split(/(?<=\n)/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      out.push(['fence', line]);
      const lang = normalizeLanguage(fence[2]) || '';
      let j = i + 1;
      const body = [];
      while (j < lines.length && !new RegExp('^\\s*' + fence[1].replace(/./g, (c) => '\\' + c) + '\\s*$').test(lines[j])) body.push(lines[j++]);
      const code = body.join('');
      if (lang && lang !== 'markdown') out.push(...tokensFor(code, lang));
      else out.push(['codeblock', code]);
      if (j < lines.length) out.push(['fence', lines[j]]);
      i = j + 1;
      continue;
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      out.push(['h', line]);
    } else if (/^\s{0,3}(?:[-*+]|\d+[.)])\s/.test(line)) {
      const m = /^(\s{0,3}(?:[-*+]|\d+[.)])\s)/.exec(line);
      out.push(['bullet', m[1]]);
      out.push(...tokenize(line.slice(m[1].length), MD_INLINE));
    } else if (/^\s{0,3}>/.test(line)) {
      out.push(['quote', line]);
    } else if (/^\s{0,3}\|.*\|\s*$/.test(line)) {
      out.push(...tokenize(line, [[sticky('\\|'), 'op'], ...MD_INLINE]));
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(['cm', line]);
    } else {
      out.push(...tokenize(line, MD_INLINE));
    }
    i++;
  }
  return out;
}

function tokensFor(text, lang) {
  switch (lang) {
    case 'html':
      return htmlTokens(text);
    case 'diff':
      return diffTokens(text);
    case 'markdown':
      return markdownTokens(text);
    default:
      return RULES[lang] ? tokenize(text, RULES[lang]) : [['', text]];
  }
}

/** Append highlighted text to a container (text nodes and spans only). */
export function highlightInto(container, text, lang) {
  if (text.length > SIZE_LIMIT || !lang || !(lang in RULES)) {
    container.appendChild(document.createTextNode(text));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const [cls, s] of tokensFor(text, lang)) {
    if (!cls) frag.appendChild(document.createTextNode(s));
    else {
      const span = document.createElement('span');
      span.className = 'hl-' + cls;
      span.textContent = s;
      frag.appendChild(span);
    }
  }
  container.appendChild(frag);
}

const NUMBERED_RE = /^\s*\d+(?:\t|→| ?\|)/;

/** True when every non-empty line starts with a line number, as `Read` output does. */
export function isNumberedListing(text) {
  const lines = text.split('\n');
  let seen = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!NUMBERED_RE.test(line)) return false;
    seen++;
  }
  return seen > 0;
}

/**
 * Render code as a <pre class="code">. Numbered listings are split into a number column and a
 * code column that does not wrap.
 */
export function renderCode(text, lang, { numbered = false } = {}) {
  const pre = document.createElement('pre');
  pre.className = 'code';
  if (numbered && isNumberedListing(text) && text.length <= SIZE_LIMIT) {
    pre.classList.add('numbered');
    const nums = document.createElement('div');
    nums.className = 'linenos';
    const code = document.createElement('div');
    code.className = 'lines';
    const numLines = [];
    const codeLines = [];
    for (const line of text.split('\n')) {
      const m = /^(\s*\d+)(?:\t|→| ?\|)(.*)$/.exec(line);
      if (m) {
        numLines.push(m[1].trim());
        codeLines.push(m[2]);
      } else {
        numLines.push('');
        codeLines.push(line);
      }
    }
    nums.textContent = numLines.join('\n');
    highlightInto(code, codeLines.join('\n'), lang);
    pre.append(nums, code);
    return pre;
  }
  highlightInto(pre, text, lang);
  return pre;
}
