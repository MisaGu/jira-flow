// Markdown → ADF, the format of descriptions and comments in Jira REST v3. Blocks: headings, paragraphs (a line
// break inside a paragraph stays a hard break), nested lists, fenced code with a language, quotes, tables, rules.
// Inline: `code`, **bold**, *italic* and _italic_ (an underscore inside a word is not italic: snake_case),
// ~~strike~~, links [text](url), <url> and bare http(s) URLs, escaping with a backslash.

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const EMPTY_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'

const text = (t, marks = []) => (t ? [{ type: 'text', text: t, ...(marks.length ? { marks } : {}) }] : [])
// A mark is added once: Jira rejects two equal marks on one text (**bold inside **bold**).
const withMark = (marks, m) => (marks.some((x) => x.type === m.type) ? marks : [...marks, m])
const para = (content) => ({ type: 'paragraph', content })
const indentOf = (l) => /^\s*/.exec(l)[0].replace(/\t/g, '    ').length

// A line → ADF nodes. marks — outer marks (bold around a link and so on); code keeps only a link: ADF does not
// combine code with other marks.
export function inline(src, marks = []) {
  const out = []
  let buf = ''
  const flush = () => {
    out.push(...text(buf, marks))
    buf = ''
  }
  const word = (c) => /[\p{L}\p{N}]/u.test(c || '')
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && i + 1 < src.length && PUNCT.includes(src[i + 1])) {
      buf += src[i + 1]
      i += 2
      continue
    }
    if (c === '`') {
      const run = /^`+/.exec(src.slice(i))[0]
      const end = src.indexOf(run, i + run.length)
      if (end > 0) {
        flush()
        let code = src.slice(i + run.length, end)
        if (/^ .* $/.test(code)) code = code.slice(1, -1)
        out.push(...text(code, [...marks.filter((m) => m.type === 'link'), { type: 'code' }]))
        i = end + run.length
        continue
      }
      buf += run
      i += run.length
      continue
    }
    if (src.startsWith('**', i) || src.startsWith('__', i) || src.startsWith('~~', i)) {
      const d = src.slice(i, i + 2)
      const end = src.indexOf(d, i + 2)
      const inner = end > i + 2 ? src.slice(i + 2, end) : ''
      // __bold__ — only at a word boundary, like _italic_.
      if (inner && !/^\s|\s$/.test(inner) && (d !== '__' || (!word(src[i - 1]) && !word(src[end + 2])))) {
        flush()
        out.push(...inline(inner, withMark(marks, { type: d === '~~' ? 'strike' : 'strong' })))
        i = end + 2
        continue
      }
    }
    if ((c === '*' || c === '_') && src[i + 1] !== c && src[i + 1] && !/\s/.test(src[i + 1]) && (c === '*' || !word(src[i - 1]))) {
      let end = i + 1
      for (;;) {
        end = src.indexOf(c, end)
        if (end < 0) break
        if (src[end + 1] === c) {
          end += 2
          continue
        }
        if (!/\s/.test(src[end - 1]) && (c === '*' || !word(src[end + 1]))) break
        end += 1
      }
      if (end > i + 1) {
        flush()
        out.push(...inline(src.slice(i + 1, end), withMark(marks, { type: 'em' })))
        i = end + 1
        continue
      }
    }
    if (c === '[') {
      const m = /^\[((?:\\.|[^\]\\])+)\]\(\s*<?([^\s()<>]+)>?\s*\)/.exec(src.slice(i))
      if (m && /^(https?:|mailto:)/i.test(m[2])) {
        flush()
        out.push(...inline(m[1], [...marks.filter((x) => x.type !== 'link'), { type: 'link', attrs: { href: m[2] } }]))
        i += m[0].length
        continue
      }
    }
    if (c === '<') {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i))
      if (m) {
        flush()
        out.push(...text(m[1], [...marks, { type: 'link', attrs: { href: m[1] } }]))
        i += m[0].length
        continue
      }
    }
    if ((c === 'h' || c === 'H') && !word(src[i - 1]) && !marks.some((m) => m.type === 'link')) {
      const m = /^https?:\/\/[^\s<>"«»]+/i.exec(src.slice(i))
      if (m) {
        const url = m[0].replace(/[.,;:!?)\]}'»]+$/, '')
        flush()
        out.push(...text(url, [...marks, { type: 'link', attrs: { href: url } }]))
        i += url.length
        continue
      }
    }
    buf += c
    i += 1
  }
  flush()
  return out
}

// Lines of a paragraph → one paragraph: a line break becomes a hard break.
function paragraphOf(lines) {
  const content = []
  lines.forEach((l, k) => {
    if (k) content.push({ type: 'hardBreak' })
    content.push(...inline(l.trim()))
  })
  return para(content)
}

const cells = (row) => {
  const t = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|'
      i += 1
    } else if (t[i] === '|') {
      out.push(cur.trim())
      cur = ''
    } else cur += t[i]
  }
  out.push(cur.trim())
  return out
}

// A list from line start: items of one level (the indent of the first item), nested ones deeper, an item continues
// with lines indented past its marker. Returns { node, next }.
function listAt(lines, start) {
  const first = ITEM.exec(lines[start]) || EMPTY_ITEM.exec(lines[start])
  const base = indentOf(lines[start])
  const ordered = /\d/.test(first[2])
  const items = []
  let i = start
  while (i < lines.length) {
    const l = lines[i]
    const m = ITEM.exec(l) || EMPTY_ITEM.exec(l)
    if (!m || indentOf(l) !== base || /\d/.test(m[2]) !== ordered) {
      if (!l.trim() && i + 1 < lines.length) {
        const n = ITEM.exec(lines[i + 1]) || EMPTY_ITEM.exec(lines[i + 1])
        if (n && indentOf(lines[i + 1]) === base && /\d/.test(n[2]) === ordered) {
          i += 1
          continue
        }
      }
      break
    }
    const body = [m[3] || '']
    const content = []
    const width = indentOf(l) + m[2].length + 1
    i += 1
    while (i < lines.length) {
      const nl = lines[i]
      if (!nl.trim()) break
      const sub = ITEM.exec(nl) || EMPTY_ITEM.exec(nl)
      if (sub && indentOf(nl) > base) {
        if (body.length) content.push(paragraphOf(body.splice(0)))
        const nested = listAt(lines, i)
        content.push(nested.node)
        i = nested.next
        continue
      }
      if (sub || indentOf(nl) < Math.min(width, base + 2) || FENCE.test(nl) || HEADING.test(nl.trim())) break
      body.push(nl)
      i += 1
    }
    if (body.length || !content.length) content.unshift(paragraphOf(body.length ? body : ['']))
    else if (content[0].type !== 'paragraph') content.unshift(para([]))
    items.push({ type: 'listItem', content })
  }
  const order = ordered ? Number.parseInt(first[2], 10) : null
  return { node: ordered ? { type: 'orderedList', attrs: { order: order || 1 }, content: items } : { type: 'bulletList', content: items }, next: i }
}

function blocks(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim()) {
      i += 1
      continue
    }
    const fence = FENCE.exec(l)
    if (fence) {
      const close = new RegExp(`^\\s*${fence[2][0] === '`' ? '`' : '~'}{${fence[2].length},}\\s*$`)
      const body = []
      i += 1
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++])
      i += 1
      out.push({ type: 'codeBlock', ...(fence[3] ? { attrs: { language: fence[3].toLowerCase() } } : {}), content: text(body.join('\n')) })
      continue
    }
    const h = HEADING.exec(l.trim())
    if (h && indentOf(l) < 4) {
      out.push({ type: 'heading', attrs: { level: h[1].length }, content: inline(h[2]) })
      i += 1
      continue
    }
    if (RULE.test(l)) {
      out.push({ type: 'rule' })
      i += 1
      continue
    }
    if (QUOTE.test(l)) {
      const body = []
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1])
      const inner = blocks(body).filter((b) => ['paragraph', 'bulletList', 'orderedList', 'codeBlock'].includes(b.type))
      out.push({ type: 'blockquote', content: inner.length ? inner : [para([])] })
      continue
    }
    if (l.trim().startsWith('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(l)
      const rows = []
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]))
      const width = head.length
      const row = (list, kind) => ({ type: 'tableRow', content: Array.from({ length: width }, (_, k) => ({ type: kind, attrs: {}, content: [para(inline(list[k] || ''))] })) })
      out.push({ type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: [row(head, 'tableHeader'), ...rows.map((r) => row(r, 'tableCell'))] })
      continue
    }
    if (ITEM.test(l) || EMPTY_ITEM.test(l)) {
      const list = listAt(lines, i)
      out.push(list.node)
      i = list.next
      continue
    }
    const body = []
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !(HEADING.test(lines[i].trim()) && indentOf(lines[i]) < 4) && !RULE.test(lines[i]) && !QUOTE.test(lines[i]) && !ITEM.test(lines[i]) && !(lines[i].trim().startsWith('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) body.push(lines[i++])
    if (!body.length) {
      body.push(lines[i])
      i += 1
    }
    out.push(paragraphOf(body))
  }
  return out
}

export function markdownToAdf(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n')
  return { type: 'doc', version: 1, content: blocks(lines) }
}
