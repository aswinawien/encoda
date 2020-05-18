/**
 * @module md
 */

/**
 * Hello contributor 👋! If you are working on this file, please
 * endeavor to remove the need for the following `eslint-disable` line 🙏.
 * Remove the line and run `npx eslint path/to/this/file.ts` to
 * see which code needs some linting ❤️.
 * See https://github.com/stencila/encoda/issues/199 for suggestions
 * on how to refactor code to avoid non-strict boolean expressions.
 */
/* eslint-disable @typescript-eslint/strict-boolean-expressions */

import { getLogger } from '@stencila/logga'
import stencila, {
  isBlockContent,
  isInlineContent,
  isListItem,
  nodeIs,
  nodeType,
  TypeMapGeneric,
} from '@stencila/schema'
import * as yaml from 'js-yaml'
import JSON5 from 'json5'
import * as MDAST from 'mdast'
// @ts-ignore
import compact from 'mdast-util-compact'
// @ts-ignore
import attrs from 'remark-attr'
// @ts-ignore
import frontmatter from 'remark-frontmatter'
// @ts-ignore
import genericExtensions from 'remark-generic-extensions'
// @ts-ignore
import math from 'remark-math'
// @ts-ignore
import parser from 'remark-parse'
// @ts-ignore
import stringifier from 'remark-stringify'
// @ts-ignore
import subSuper from 'remark-sub-super'
import unified from 'unified'
import * as UNIST from 'unist'
// @ts-ignore
import filter from 'unist-util-filter'
// @ts-ignore
import map from 'unist-util-map'
// @ts-ignore
import { selectAll } from 'unist-util-select'
import * as vfile from '../../util/vfile'
import { HTMLCodec } from '../html'
import { TxtCodec } from '../txt'
import { Codec, CommonDecodeOptions } from '../types'
import { stringifyHTML } from './stringifyHtml'
import { TexCodec } from '../tex'
import transform from '../../util/transform'

const texCodec = new TexCodec()

export const log = getLogger('encoda:md')

export class MdCodec extends Codec implements Codec {
  public readonly mediaTypes = ['text/markdown', 'text/x-markdown']

  /**
   * Decode a `VFile` with Markdown contents to a `stencila.Node`.
   *
   * @param file The `VFile` to decode
   * @returns A promise that resolves to a `stencila.Node`
   */
  public readonly decode = async (
    file: vfile.VFile,
    options: CommonDecodeOptions = this.commonDecodeDefaults
  ): Promise<stencila.Node> => {
    const { isStandalone } = options
    const md = await vfile.dump(file)
    return decodeMarkdown(md, isStandalone)
  }

  /**
   * Encode a `stencila.Node` to a `VFile` with Markdown contents.
   *
   * @param thing The `stencila.Node` to encode
   * @returns A promise that resolves to a `VFile`
   */
  public readonly encode = async (
    node: stencila.Node
  ): Promise<vfile.VFile> => {
    const prepared = await encodePrepare(node)
    const md = encodeMarkdown(prepared)
    return Promise.resolve(vfile.load(md))
  }
}

/**
 * Matches new lines, **the preceding character**, and any following white space
 * on the next line. This so so that trailing spaces can be collapsed into a space.
 * To use you need to include the matched group in the replacement value.
 * @see https://regexr.com/4i45o
 * @see https://stackoverflow.com/a/18012521
 * @example myString.replace(whiteSpaceRegEx, '$1 ')
 */

const whiteSpaceRegEx = new RegExp(/(^|[^\n\s])[\n]+\s*(?![\n])/g)

export const mdastBlockContentTypes: TypeMapGeneric<MDAST.BlockContent> = {
  blockquote: 'blockquote',
  code: 'code',
  heading: 'heading',
  html: 'html',
  list: 'list',
  paragraph: 'paragraph',
  table: 'table',
  thematicBreak: 'thematicBreak',
}

export const mdastPhrasingContentTypes: TypeMapGeneric<MDAST.PhrasingContent> = {
  break: 'break',
  delete: 'delete',
  emphasis: 'emphasis',
  footnote: 'footnote',
  footnoteReference: 'footnoteReference',
  html: 'html',
  image: 'image',
  imageReference: 'imageReference',
  inlineCode: 'inlineCode',
  link: 'link',
  linkReference: 'linkReference',
  strong: 'strong',
  text: 'text',
}

const isMdastBlockContent = nodeIs(mdastBlockContentTypes)
const isMdastPhrasingContent = nodeIs(mdastPhrasingContentTypes)

/**
 * Options for `remark-frontmatter` plugin
 *
 * @see https://github.com/remarkjs/remark-frontmatter#matter
 */
const FRONTMATTER_OPTIONS = [{ type: 'yaml', marker: '-' }]

/**
 * Options for `remark-attr` plugin
 */
const ATTR_OPTIONS = { scope: 'permissive' }

/**
 * Registered generic extensions.
 *
 * @see Extension
 */
const GENERIC_EXTENSIONS = [
  'quote',
  'expr',
  'chunk',
  'figure',
  'include',

  'null',
  'true',
  'false',
  'boolean',
  'number',
  'array',
  'object',
]
const extensionHandlers: { [key: string]: any } = {}
for (const ext of GENERIC_EXTENSIONS) {
  extensionHandlers[ext] = { replace: decodeExtension }
}

/**
 * Decode a string of Markdown content to a Stencila `Node`
 */
export function decodeMarkdown(
  md: string,
  isStandalone = true
): stencila.Article | stencila.Node[] {
  const mdast = unified()
    .use(parser, { commonmark: true })
    .use(frontmatter, FRONTMATTER_OPTIONS)
    .use(attrs, ATTR_OPTIONS)
    .use(subSuper)
    .use(math)
    .use(genericExtensions, { elements: extensionHandlers })
    .parse(md)
  compact(mdast, true)
  const root = stringifyHTML(resolveReferences(mdast)) as MDAST.Root

  return isStandalone ? decodeArticle(root) : root.children.map(decodeNode)
}

/**
 * Encode a Stencila `Node` to a Markdown `string`.
 */
export function encodeMarkdown(node: stencila.Node): string {
  const encoded = encodeNode(node)
  if (encoded === undefined) return ''

  let mdast = filter(
    encoded,
    // @ts-ignore
    (node: UNIST.Node | undefined) => typeof node !== 'undefined'
  ) as UNIST.Node
  mdast = stringifyExtensions(mdast)
  mdast = stringifyAttrs(mdast)

  return unified()
    .use(stringifier)
    .use(frontmatter, FRONTMATTER_OPTIONS)
    .stringify(mdast)
}

/**
 * Do any async operations necessary on the node tree before encoding it.
 *
 * This avoids having to "taint" the whole decode function call stack with
 * async calls.
 */
async function encodePrepare(node: stencila.Node): Promise<stencila.Node> {
  return transform(node, async (node) => {
    if (stencila.isA('MathFragment', node) || stencila.isA('MathBlock', node)) {
      if (node.mathLanguage !== 'tex') {
        const text = await texCodec.dump(node)
        return {
          ...node,
          mathLanguage: 'tex',
          text,
        }
      }
    }
    return node
  })
}

function decodeNode(node: UNIST.Node): stencila.Node {
  const type = node.type
  switch (type) {
    case 'heading':
      return decodeHeading(node as MDAST.Heading)
    case 'paragraph':
      return decodeParagraph(node as MDAST.Paragraph)
    case 'blockquote':
      return decodeBlockquote(node as MDAST.Blockquote)
    case 'math':
      return decodeMath(node as MDAST.Literal)
    case 'code':
      return decodeCodeblock(node as MDAST.Code)
    case 'list':
      return decodeList(node as MDAST.List)
    case 'listItem':
      return decodeListItem(node as MDAST.ListItem)
    case 'table':
      return decodeTable(node as MDAST.Table)
    case 'thematicBreak':
      return decodeThematicBreak()

    case 'link':
      return decodeLink(node as MDAST.Link)
    case 'emphasis':
      return decodeEmphasis(node as MDAST.Emphasis)
    case 'strong':
      return decodeStrong(node as MDAST.Strong)
    case 'delete':
      return decodeDelete(node as MDAST.Delete)
    case 'sub':
      return decodeSubscript(node as MDAST.Parent)
    case 'sup':
      return decodeSuperscript(node as MDAST.Parent)
    case 'inlineMath':
      return decodeMath(node as MDAST.Literal)
    case 'inlineCode':
      return decodeInlineCode(node as MDAST.InlineCode)
    case 'image':
      return decodeImage(node as MDAST.Image)
    case 'text':
      return decodeText(node as MDAST.Text)
    case 'inline-extension':
    case 'block-extension': {
      const ext = (node as unknown) as Extension
      switch (ext.name) {
        case 'chunk':
          return decodeCodeChunk(ext)
        case 'figure':
          return decodeFigure(ext)
        case 'quote':
          return decodeQuote(ext)
        case 'include':
          return decodeInclude(ext)

        case 'null':
          return decodeNull()
        case 'boolean':
        case 'true':
        case 'false':
          return decodeBoolean(ext)
        case 'number':
          return decodeNumber(ext)
        case 'array':
          return decodeArray(ext)
        case 'object':
          return decodeObject(ext)

        default:
          if (ext.name) {
            log.warn(`Unhandled generic extension "${ext.name}"`)
          } else {
            log.warn(
              `Unregistered generic extension "${node.data && node.data.hName}"`
            )
          }
          return ''
      }
    }
    case 'html':
      return decodeHTML(node as MDAST.HTML)

    default:
      log.warn(`No Markdown decoder for MDAST node type "${type}"`)
      return ''
  }
}

function encodeNode(node: stencila.Node): UNIST.Node | undefined {
  const type_ = nodeType(node)
  switch (type_) {
    case 'Article':
      return encodeArticle(node as stencila.Article)

    case 'Include':
      return encodeInclude(node as stencila.Include)

    case 'Heading':
      return encodeHeading(node as stencila.Heading)
    case 'Paragraph':
      return encodeParagraph(node as stencila.Paragraph)
    case 'QuoteBlock':
      return encodeQuoteBlock(node as stencila.QuoteBlock)
    case 'MathBlock':
      return encodeMath(node as stencila.MathBlock)
    case 'CodeBlock':
      return encodeCodeBlock(node as stencila.CodeBlock)
    case 'CodeChunk':
      return encodeCodeChunk(node as stencila.CodeChunk)
    case 'List':
      return encodeList(node as stencila.List)
    case 'ListItem':
      return encodeListItem(node as stencila.ListItem)
    case 'Table':
      return encodeTable(node as stencila.Table)
    case 'Figure':
      return encodeFigure(node as stencila.Figure)
    case 'ThematicBreak':
      return encodeThematicBreak()

    case 'Cite':
      return encodeCite(node as stencila.Cite)
    case 'Link':
      return encodeLink(node as stencila.Link)
    case 'Emphasis':
      return encodeEmphasis(node as stencila.Emphasis)
    case 'Strong':
      return encodeStrong(node as stencila.Strong)
    case 'Delete':
      return encodeDelete(node as stencila.Delete)
    case 'Subscript':
      return encodeSubscript(node as stencila.Subscript)
    case 'Superscript':
      return encodeSuperscript(node as stencila.Superscript)

    case 'Quote':
      return encodeQuote(node as stencila.Quote)
    case 'MathFragment':
      return encodeMath(node as stencila.MathFragment)
    case 'CodeFragment':
      return encodeCodeFragment(node as stencila.CodeFragment)
    case 'CodeExpression':
      return encodeCodeExpression(node as stencila.CodeExpression)
    case 'ImageObject':
      return encodeImageObject(node as stencila.ImageObject)

    case 'Text':
      return encodeString(node as string)
    case 'Null':
      return encodeNull()
    case 'Boolean':
      return encodeBoolean(node as boolean)
    case 'Number':
      return encodeNumber(node as number)
    case 'Array':
      return encodeArray(node as any[])
    case 'Object':
      return encodeObject(node as object)

    default:
      log.warn(`No Markdown encoder for Stencila node type "${type_}"`)
      return encodeString('')
  }
}

function encodeContent(node: stencila.Node): MDAST.Content {
  return encodeNode(node) as MDAST.Content
}

function decodePhrasingContent(
  node: MDAST.PhrasingContent
): stencila.InlineContent {
  return decodeNode(node) as stencila.InlineContent
}

function encodeInlineContent(
  node: stencila.InlineContent
): MDAST.PhrasingContent {
  return encodeNode(node) as MDAST.PhrasingContent
}

function decodeBlockContent(node: MDAST.BlockContent): stencila.BlockContent {
  return decodeNode(node) as stencila.BlockContent
}

function encodeBlockContent(node: stencila.BlockContent): MDAST.BlockContent {
  return encodeNode(node) as MDAST.BlockContent
}

/**
 * Decode a `MDAST.root` node to a `stencila.Article`
 *
 * If the root has a front matter node (defined using YAML), that
 * meta data is added to the top level of the document. Other
 * child nodes are added to the article's `content` property.
 *
 * If the first content node if a level 1 heading, use
 * it as the `title`.
 *
 * @param root The MDAST root to decode
 */
function decodeArticle(root: MDAST.Root): stencila.Article {
  let title
  let meta
  const content: stencila.Node[] = []
  for (const child of root.children) {
    if (child.type === 'yaml') {
      const frontmatter = yaml.safeLoad(child.value)
      if ('title' in frontmatter) title = frontmatter.title
      meta = frontmatter
    } else if (
      title === undefined &&
      child.type === 'heading' &&
      child.depth === 1
    ) {
      const content = child.children.map(decodeNode)
      title =
        content.length === 1 && typeof content[0] === 'string'
          ? content[0]
          : content
    } else {
      content.push(decodeNode(child))
    }
  }

  return stencila.article({
    title,
    ...meta,
    content,
  })
}

/**
 * Encode a `stencila.Article` to a `MDAST.Root`
 *
 * The article's `content` property becomes the root's `children`
 * and any other properties are serialized as YAML
 * front matter and prepended to the children.
 *
 * @param node The Stencila article to encode
 */
function encodeArticle(article: stencila.Article): MDAST.Root {
  const root: MDAST.Root = {
    type: 'root',
    children: [],
  }

  // Encode the article body
  if (article.content) {
    root.children = article.content.map(encodeContent)
  }

  // Add other properties as frontmatter
  const frontmatter: { [key: string]: any } = {}
  for (const [key, value] of Object.entries(article)) {
    if (!['type', 'content'].includes(key)) {
      frontmatter[key] = value
    }
  }
  if (Object.keys(frontmatter).length) {
    const yamlNode: MDAST.YAML = {
      type: 'yaml',
      value: yaml.safeDump(frontmatter, { skipInvalid: true }).trim(),
    }
    root.children.unshift(yamlNode)
  }

  return root
}

/**
 * Decode a `include:` block extension to a `stencila.Include`
 */
function decodeInclude(ext: Extension): stencila.Include {
  const include: stencila.Include = {
    type: 'Include',
    source: ext.argument ?? '',
  }
  if (ext.content) {
    const article = decodeMarkdown(ext.content) as stencila.Article
    include.content = (article.content ?? []).filter(isBlockContent)
  }
  return include
}

/**
 * Encode a `stencila.Include` to a `include:` block extension
 */
function encodeInclude(include: stencila.Include): Extension {
  const { source, content = [] } = include
  const md = encodeMarkdown({ type: 'Article', content }).trim()
  return {
    type: 'block-extension',
    name: 'include',
    argument: source,
    content: md,
  }
}

/**
 * Decode a `MDAST.Heading` to a `stencila.Heading`
 */
function decodeHeading(heading: MDAST.Heading): stencila.Heading {
  return {
    type: 'Heading',
    depth: heading.depth,
    content: heading.children.map(decodePhrasingContent),
  }
}

/**
 * Encode a `stencila.Heading` to a `MDAST.Heading`
 */
function encodeHeading(heading: stencila.Heading): MDAST.Heading {
  return {
    type: 'heading',
    depth: heading.depth as 1 | 2 | 3 | 4 | 5 | 6,
    children: heading.content.map(encodeInlineContent),
  }
}

/**
 * Decode a `MDAST.Paragraph` to a `stencila.Paragraph`
 */
function decodeParagraph(paragraph: MDAST.Paragraph): stencila.Paragraph {
  return {
    type: 'Paragraph',
    content: paragraph.children.map(decodePhrasingContent),
  }
}

/**
 * Encode a `stencila.Paragraph` to a `MDAST.Paragraph`
 *
 * Returns `undefined` (i.e skip this node) if the paragraph
 * is empty (not content, or only whitespace)
 */
function encodeParagraph(
  paragraph: stencila.Paragraph
): MDAST.Paragraph | undefined {
  const content = paragraph.content
  if (
    content.length === 0 ||
    (content.length === 1 &&
      nodeType(content[0]) === 'Text' &&
      (content[0] as string).trim().length === 0)
  ) {
    return undefined
  } else {
    return {
      type: 'paragraph',
      children: content.map(encodeInlineContent),
    }
  }
}

/**
 * Decode a `MDAST.Blockquote` to a `stencila.QuoteBlock`
 */
function decodeBlockquote(block: MDAST.Blockquote): stencila.QuoteBlock {
  return {
    type: 'QuoteBlock',
    content: block.children.map(decodeBlockContent),
  }
}

/**
 * Encode a `stencila.QuoteBlock` to a `MDAST.Blockquote`
 */
function encodeQuoteBlock(block: stencila.QuoteBlock): MDAST.Blockquote {
  return {
    type: 'blockquote',
    children: block.content.map(encodeBlockContent),
  }
}

/**
 * Decode a `MDAST.Code` to a `stencila.CodeBlock`
 *
 * The ["info string"](https://spec.commonmark.org/0.29/#info-string)
 * is decoded to the `meta` dictionary on the `CodeBlock`. For example,
 * the code block starting with,
 *
 * ~~~markdown
 * ```python python meta1 meta2=foo meta3="bar baz"
 * ~~~
 *
 * is decoded to a `CodeBlock` with `language` `"python"` and `meta`
 * `{meta1:"", meta2:"foo", meta3:"bar baz" }`
 */
function decodeCodeblock(code: MDAST.Code): stencila.CodeBlock {
  const codeBlock: stencila.CodeBlock = {
    type: 'CodeBlock',
    text: code.value,
  }
  if (code.lang) codeBlock.programmingLanguage = code.lang
  // The `remark-attrs` plugin parses metadata from the info string
  // into `data.hProperties` but also (erroneously?) seems to
  // parse some of the content of the first line of code so
  // we ensure that `code.meta` (unparsed info string) is present.
  const meta =
    code.meta &&
    code.data &&
    (code.data.hProperties as { [key: string]: string })
  if (meta) codeBlock.meta = meta
  return codeBlock
}

/**
 * Encode a `stencila.CodeBlock` to a `MDAST.Code` node.
 */
function encodeCodeBlock(block: stencila.CodeBlock): MDAST.Code {
  const { text, programmingLanguage, meta } = block
  return {
    type: 'code',
    lang: programmingLanguage,
    meta: meta !== undefined ? stringifyMeta(meta) : '',
    value: text.trimRight(),
  }
}

/**
 * Decode a `chunk:` block extension to a `stencila.CodeChunk`
 */
function decodeCodeChunk(ext: Extension): stencila.CodeChunk {
  if (ext.content === undefined) {
    log.warn(`Code chunk has no content`)
    return stencila.codeChunk({ text: '' })
  }

  const article = decodeMarkdown(ext.content) as stencila.Article
  const nodes = (article.content && article.content) || []

  const first = nodes[0]
  if (!stencila.isA('CodeBlock', first)) {
    log.warn(`Code chunk extension has no code`)
    return stencila.codeChunk({ text: '' })
  }

  const { text, programmingLanguage, meta } = first

  const outputs: stencila.Node[] = []
  if (nodes.length > 1) {
    const pushOutputs = function (outputNodes: stencila.Node[]) {
      if (outputNodes.length === 1) {
        const node = outputNodes[0]
        if (stencila.isA('Paragraph', node) && node.content.length === 1) {
          // Unwrap the paragraph (e.g. into a `string`, or `number`)
          outputs.push(node.content[0])
        } else {
          // Singular node
          outputs.push(node)
        }
      }
      // An array of nodes
      // In the future these may wrapped into a container node to avoid having
      // a `BlockContent[]` as an output
      else outputs.push(outputNodes)
    }

    let outputNodes: stencila.Node[] = []
    for (const outputContainer of nodes.slice(1)) {
      // When a thematic break is encountered, start a new
      // output
      if (stencila.isA('ThematicBreak', outputContainer)) {
        pushOutputs(outputNodes)
        outputNodes = []
        continue
      }
      outputNodes.push(outputContainer)
    }
    pushOutputs(outputNodes)
  }

  return stencila.codeChunk({
    text,
    programmingLanguage,
    meta,
    outputs: outputs.length > 0 ? outputs : undefined,
  })
}

/**
 * Encode a `stencila.CodeChunk` to a `chunk:` block extension
 */
function encodeCodeChunk(chunk: stencila.CodeChunk): Extension {
  const { programmingLanguage = 'text', meta, text, outputs } = chunk
  const nodes: stencila.Node[] = []

  // Encode the code as a `CodeBlock`
  nodes.push(
    stencila.codeBlock({
      text,
      programmingLanguage,
      meta,
    })
  )

  // Separate each item in `outputs` with a `ThematicBreak`
  if (outputs !== undefined) {
    let index = 0
    for (const output of outputs) {
      if (index !== 0) nodes.push({ type: 'ThematicBreak' })
      // If the array only has block content then add those separately instead as an array
      // This may be obviated if we use a container node instead for block content
      if (
        Array.isArray(output) &&
        output.filter(stencila.isBlockContent).length === output.length
      ) {
        nodes.push(...output)
      } else nodes.push(output)
      index += 1
    }
  }

  // Encode nodes as Markdown
  const md = encodeMarkdown({ type: 'Article', content: nodes }).trim()

  return {
    type: 'block-extension',
    name: 'chunk',
    content: md,
  }
}

/**
 * Decode a `figure:` block extension to a `stencila.Figure`.
 *
 * The first node of the extension is the `content` property
 * of the `Figure`. Subsequent nodes are the `caption` property.
 * The extension's `argument` becomes the figure's `label`.
 */
function decodeFigure(ext: Extension): stencila.Figure {
  if (ext.content === undefined) {
    log.warn(`Figure has no content`)
    return stencila.figure()
  }
  const article = decodeMarkdown(ext.content) as stencila.Article
  const nodes = (article.content && article.content) || []

  return stencila.figure({
    content: nodes.slice(0, 1),
    caption: nodes.slice(1),
    label: ext.argument,
  })
}

/**
 * Encode a `stencila.Figure` to a `figure:` block extension
 *
 * The `content` of the figure e.g. a `ImageObject` or `CodeChunk` will be the
 * first node of the extension's content. The `caption` is the remainder.
 *
 * In the future, if there is more than one content node then we
 * may use a `ThematicBreak` to separate content from caption.
 */
function encodeFigure(figure: stencila.Figure): Extension {
  const { content, caption, label } = figure

  const nodes = [...(content ?? []), ...(caption ?? [])]
  const md = encodeMarkdown({ type: 'Article', content: nodes }).trim()

  return {
    type: 'block-extension',
    name: 'figure',
    content: md,
    argument: label,
  }
}

/**
 * Decode a `MDAST.List` to a `stencila.List`
 */
function decodeList(list: MDAST.List): stencila.List {
  return {
    type: 'List',
    order: list.ordered ? 'ascending' : 'unordered',
    items: list.children.map(decodeNode).filter(isListItem),
  }
}

/**
 * Encode a `stencila.List` to a `MDAST.List`
 */
function encodeList(list: stencila.List): MDAST.List {
  return {
    type: 'list',
    ordered: list.order === 'ascending',
    children: list.items.filter(isListItem).map(encodeListItem),
  }
}

/**
 * Encode a `MDAST.ListItem` to a `stencila.ListItem`
 */
function encodeListItem(listItem: stencila.ListItem): MDAST.ListItem {
  const { isChecked, content = [] } = listItem
  const _listItem: MDAST.ListItem = {
    type: 'listItem',
    children: content.map((child) => {
      const mdast = encodeNode(child)
      if (isMdastBlockContent(mdast)) return mdast
      if (isMdastPhrasingContent(mdast))
        return { type: 'paragraph', children: [mdast] }
      log.warn(`Unhandled list item MDAST type ${mdast?.type}`)
      return { type: 'paragraph', children: [] }
    }),
  }
  return isChecked !== undefined
    ? { ..._listItem, checked: isChecked }
    : _listItem
}

/**
 * Decode a `MDAST.List` to a `stencila.List`
 */
function decodeListItem(listItem: MDAST.ListItem): stencila.ListItem {
  const _listItem: stencila.ListItem = {
    type: 'ListItem',
    content: listItem.children.map(decodeNode).filter(isBlockContent),
  }
  return listItem.checked === true || listItem.checked === false
    ? { ..._listItem, isChecked: listItem.checked || false }
    : _listItem
}

/**
 * Decode a `MDAST.Table` to a `stencila.Table`
 */
function decodeTable(table: MDAST.Table): stencila.Table {
  return {
    type: 'Table',
    rows: table.children.map(
      (row: MDAST.TableRow): stencila.TableRow => {
        return {
          type: 'TableRow',
          cells: row.children.map(
            (cell: MDAST.TableCell): stencila.TableCell => {
              return {
                type: 'TableCell',
                content: cell.children.map(decodePhrasingContent),
              }
            }
          ),
        }
      }
    ),
  }
}

/**
 * Encode a `stencila.Table` to a `MDAST.Table`
 */
function encodeTable(table: stencila.Table): MDAST.Table {
  return {
    type: 'table',
    children: table.rows.map(
      (row: stencila.TableRow): MDAST.TableRow => {
        return {
          type: 'tableRow',
          children: row.cells.map(
            (cell: stencila.TableCell): MDAST.TableCell => {
              return {
                type: 'tableCell',
                children: cell.content
                  .filter(isInlineContent)
                  .map(encodeInlineContent),
              }
            }
          ),
        }
      }
    ),
  }
}

/**
 * Decode a `MDAST.ThematicBreak` to a `stencila.ThematicBreak`
 */
function decodeThematicBreak(): stencila.ThematicBreak {
  return {
    type: 'ThematicBreak',
  }
}

/**
 * Encode a `stencila.ThematicBreak` to a `MDAST.ThematicBreak`
 */
function encodeThematicBreak(): MDAST.ThematicBreak {
  return {
    type: 'thematicBreak',
  }
}

/**
 * Decode a `MDAST.Link` to a `stencila.Link`
 */
function decodeLink(link: MDAST.Link): stencila.Link {
  const link_: stencila.Link = {
    type: 'Link',
    target: link.url,
    content: link.children.map(decodePhrasingContent),
  }
  // The `remark-attrs` plugin decodes curly brace attributes to `data.hProperties`
  const meta = (link.data && link.data.hProperties) as {
    [key: string]: string
  }
  if (meta) link_.meta = meta
  if (link.title) link_.title = link.title
  return link_
}

/**
 * Encode a Stencila `Cite` node to a MDAST `Text` node
 * with Pandoc style `@`-prefixed citations e.g. `@smith04`.
 */
function encodeCite(cite: stencila.Cite): MDAST.Text {
  return {
    type: 'text',
    value: `@${cite.target}`,
  }
}

/**
 * Encode a `stencila.Link` to a `MDAST.Link`
 */
function encodeLink(link: stencila.Link): MDAST.Link {
  const data = { hProperties: link.meta }
  return {
    type: 'link',
    url: link.target,
    title: link.title,
    children: link.content.map(
      (node) => encodeInlineContent(node) as MDAST.StaticPhrasingContent
    ),
    data,
  }
}

/**
 * Decode a `MDAST.Emphasis` to a `stencila.Emphasis`
 */
function decodeEmphasis(emphasis: MDAST.Emphasis): stencila.Emphasis {
  return {
    type: 'Emphasis',
    content: emphasis.children.map(decodePhrasingContent),
  }
}

/**
 * Encode a `stencila.Emphasis` to a `MDAST.Emphasis`
 */
function encodeEmphasis(emphasis: stencila.Emphasis): MDAST.Emphasis {
  return {
    type: 'emphasis',
    children: emphasis.content.map(encodeInlineContent),
  }
}

/**
 * Decode a `MDAST.Strong` to a `stencila.Strong`
 */
function decodeStrong(strong: MDAST.Strong): stencila.Strong {
  return {
    type: 'Strong',
    content: strong.children.map(decodePhrasingContent),
  }
}

/**
 * Encode a `stencila.Strong` to a `MDAST.Strong`
 */
function encodeStrong(strong: stencila.Strong): MDAST.Strong {
  return {
    type: 'strong',
    children: strong.content.map(encodeInlineContent),
  }
}

/**
 * Decode a `MDAST.Delete` to a `stencila.Delete`
 */
function decodeDelete(delet: MDAST.Delete): stencila.Delete {
  return {
    type: 'Delete',
    content: delet.children.map(decodePhrasingContent),
  }
}

/**
 * Encode a `stencila.Delete` to a `MDAST.Delete`
 */
function encodeDelete(delet: stencila.Delete): MDAST.Delete {
  return {
    type: 'delete',
    children: delet.content.map(encodeInlineContent),
  }
}

/**
 * Decode a MDAST `sub` node to a Stencila `Subscript` node.
 */
const decodeSubscript = (sub: MDAST.Parent): stencila.Subscript => {
  return stencila.subscript({
    content: sub.children.map((node) =>
      decodePhrasingContent(node as MDAST.PhrasingContent)
    ),
  })
}

/**
 * Encode a Stencila `Subscript` as a MDAST `text` node with surrounding tildes.
 *
 * This assumes that there is only `string`s in the `content` of the subscript.
 */
const encodeSubscript = (sub: stencila.Subscript): MDAST.Text => {
  return {
    type: 'text',
    value: `~${TxtCodec.stringify(sub)}~`,
  }
}

/**
 * Decode a MDAST `sup` node to a Stencila `Superscript` node.
 */
const decodeSuperscript = (sup: MDAST.Parent): stencila.Superscript => {
  return stencila.superscript({
    content: sup.children.map((node) =>
      decodePhrasingContent(node as MDAST.PhrasingContent)
    ),
  })
}

/**
 * Encode a Stencila `Superscript` as a MDAST `text` node with surrounding carets.
 *
 * This assumes that there is only `string`s in the `content` of the subscript.
 */
const encodeSuperscript = (sup: stencila.Superscript): MDAST.Text => {
  return {
    type: 'text',
    value: `^${TxtCodec.stringify(sup)}^`,
  }
}

/**
 * Decode a `!quote` inline extension to a `Quote`.
 *
 * Valid quotes include:
 *
 *   - `!quote[Quoted content]`
 *   - `!quote[Quoted content with _emphasis_](https://example.org)`
 */
function decodeQuote(ext: Extension): stencila.Quote {
  const quote: stencila.Quote = {
    type: 'Quote',
    // TODO: possibly decode the ext.content as Markdown?
    content: ext.content ? [ext.content] : [],
  }
  const cite = ext.argument
  if (cite) quote.cite = cite
  return quote
}

/**
 * Encode a `stencila.Quote` to a `!quote` inline extension
 */
function encodeQuote(quote: stencila.Quote): Extension {
  return {
    type: 'inline-extension',
    name: 'quote',
    // TODO: Handle cases where content is more than one string
    content: quote.content[0] as string,
    argument: quote.cite as string,
  }
}

/**
 * Decode a MDAST `inlineMath` or `math` node to either a Stencila `MathFragment`
 * or `MathBlock`.
 */
function decodeMath(
  math: MDAST.Literal
): stencila.MathFragment | stencila.MathBlock {
  const { type, value } = math
  return (type === 'inlineMath' ? stencila.mathFragment : stencila.mathBlock)({
    mathLanguage: 'tex',
    text: value,
  })
}

/**
 * Encode a `MathFragment` or `MathBlock` to TeX with delimiters.
 *
 * Uses an MDAST `HTML` node to avoid escaping of back slashes etc
 */
function encodeMath(math: stencila.Math): MDAST.HTML {
  const { type, mathLanguage, text } = math
  const [begin, end] = type === 'MathFragment' ? ['$', '$'] : ['$$\n', '\n$$']
  if (mathLanguage !== 'tex')
    log.warn(`Math node contains unhandled math language: ${mathLanguage}`)
  return {
    type: 'html',
    value: `${begin}${text.trim()}${end}`,
  }
}

/**
 * Decode a `MDAST.InlineCode` to either a static `stencila.CodeFragment`
 * or an executable `stencila.CodeExpression`.
 */
function decodeInlineCode(
  inlineCode: MDAST.InlineCode
): stencila.CodeFragment | stencila.CodeExpression {
  const attrs =
    inlineCode.data &&
    (inlineCode.data.hProperties as { [key: string]: string })

  if (attrs && attrs.type === 'expr') {
    const codeExpr = stencila.codeExpression({ text: inlineCode.value })
    const { type, lang, output, ...rest } = attrs
    if (output) codeExpr.output = JSON.parse(output.replace(/"/g, '"'))
    if (lang) codeExpr.programmingLanguage = lang
    if (Object.keys(rest).length) codeExpr.meta = rest
    return codeExpr
  } else {
    const codeFrag = stencila.codeFragment({ text: inlineCode.value })
    if (attrs) {
      const { lang, ...rest } = attrs
      if (lang) codeFrag.programmingLanguage = lang
      if (Object.keys(rest).length) codeFrag.meta = rest
    }
    return codeFrag
  }
}

/**
 * Encode a `stencila.CodeFragment` node to a `MDAST.InlineCode`
 */
function encodeCodeFragment(code: stencila.CodeFragment): MDAST.InlineCode {
  let attrs
  if (code.programmingLanguage) attrs = { lang: code.programmingLanguage }
  if (code.meta) attrs = { ...attrs, ...code.meta }
  return {
    type: 'inlineCode',
    data: { hProperties: attrs },
    value: code.text,
  }
}

/**
 * Encode a `stencila.CodeExpression` to a `MDAST.InlineCode` with
 * `{type=expr}`
 */
function encodeCodeExpression(
  codeExpr: stencila.CodeExpression
): MDAST.InlineCode {
  const attrs: { [key: string]: any } = {
    type: 'expr',
    lang: codeExpr.programmingLanguage,
    ...codeExpr.meta,
  }

  if (codeExpr.output)
    attrs.output = JSON.stringify(codeExpr.output).replace(/"/g, '\\"')

  return {
    type: 'inlineCode',
    data: { hProperties: attrs },
    value: codeExpr.text || '',
  }
}

/**
 * Decode a `MDAST.Image` to a `stencila.ImageObject`
 */
function decodeImage(image: MDAST.Image): stencila.ImageObject {
  const imageObject: stencila.ImageObject = {
    type: 'ImageObject',
    contentUrl: image.url,
  }
  if (image.title) imageObject.title = image.title
  if (image.alt) imageObject.text = image.alt
  // The `remark-attrs` plugin decodes curly brace attributes to `data.hProperties`
  const meta =
    image.data && (image.data.hProperties as { [key: string]: string })
  if (meta) imageObject.meta = meta
  return imageObject
}

/**
 * Encode a `stencila.ImageObject` to a `MDAST.Image`
 */
function encodeImageObject(imageObject: stencila.ImageObject): MDAST.Image {
  const image: MDAST.Image = {
    type: 'image',
    url: imageObject.contentUrl || '',
  }
  if (imageObject.title) image.title = TxtCodec.stringify(imageObject.title)
  if (imageObject.text) image.alt = imageObject.text
  if (imageObject.meta) image.data = { hProperties: imageObject.meta }
  return image
}

/**
 * Decode a `MDAST.Text` to a `string`.
 *
 * Replaces newline and carriage returns with a space.
 * This is done to ensure that paragraphs that are written
 * across multiple lines do not have newlines in them.
 */
function decodeText(text: MDAST.Text): string {
  return text.value.replace(whiteSpaceRegEx, '$1 ')
}

/**
 * Encode a `string` to a `MDAST.Text`
 */
function encodeString(value: string): MDAST.Text {
  return {
    type: 'text',
    value: value.replace(whiteSpaceRegEx, '$1 '),
  }
}

/**
 * Decode a `!null` inline extension to `null`
 */
function decodeNull(): null {
  return null
}

/**
 * Encode `null` to a `!null` inline extension
 */
function encodeNull(): Extension {
  return { type: 'inline-extension', name: 'null' }
}

/**
 * Decode a `!true`, `!false`, `!boolean` inline extension to a `boolean`
 *
 * Valid booleans include (the first three are the preferred and the default,
 * the last should be avoided):
 *
 *   - `!true` or `!false`
 *   - `!boolean(true)` and `!boolean(1)`
 *   - `!boolean(false)` and `!boolean(0)`
 *   - `!boolean` (decoded to `true`)
 *   - `!boolean[true]` and `!boolean[1]` etc
 */
function decodeBoolean(ext: Extension): boolean {
  switch (ext.name) {
    case 'true':
      return true
    case 'false':
      return false
    default: {
      const value = ext.argument ?? ext.content ?? 'true'
      return !!(value === 'true' || value === '1')
    }
  }
}

/**
 * Encode a `boolean` to a `!true` or `!false`.
 */
function encodeBoolean(value: boolean): Extension {
  return { type: 'inline-extension', name: value ? 'true' : 'false' }
}

/**
 * Decode a `!number` inline extension to a `number`.
 *
 * Valid numbers include (the first is the preferred and the default,
 * the last should be avoided):
 *
 *   - `!number(3.14)`
 *   - `!number` (decoded to `0`)
 *   - `!number[3.14]`
 */
function decodeNumber(ext: Extension): number {
  return parseFloat(ext.argument ?? ext.content ?? '0')
}

/**
 * Encode a `number` to a `!number` inline extension
 */
function encodeNumber(value: number): Extension {
  return {
    type: 'inline-extension',
    name: 'number',
    argument: value.toString(),
  }
}

/**
 * Decode an `!array` inline extension to an `Array`.
 *
 * Valid arrays include (the first is the preferred and the default,
 * the last should be avoided):
 *
 *   - `!array(1, 2)`
 *   - `!array` (decoded to `[]`)
 *   - `!array[1, 2]`
 */
function decodeArray(ext: Extension): any[] {
  const items = ext.argument ?? ext.content ?? ''
  const array = JSON5.parse(`[${items}]`)
  return array
}

/**
 * Encode an `array` to a `!array` inline extension
 */
function encodeArray(value: any[]): Extension {
  const argument = JSON5.stringify(value).slice(1, -1)
  return { type: 'inline-extension', name: 'array', argument }
}

/**
 * Decode an `!object` inline extension to an `Object`.
 *
 * Valid objects include (the first is the preferred and the default,
 * the last should be avoided):
 *
 *   - `!object("key":value, ...)` (comma separated pairs, values can be any JSON primitives)
 *   - `!object{key=string ...}` (space separated pairs; values can only be strings)
 *   - `!object` (decoded to `{}`)
 *   - `!object["key":"value", ...]`
 */
function decodeObject(ext: Extension): object {
  if (ext.properties) {
    // Extension properties always contain `className` and `id`, which may
    // be undefined, so drop them.
    const props: { [key: string]: any } = {}
    for (const [key, value] of Object.entries(ext.properties)) {
      // tslint:disable-next-line
      if (typeof value !== 'undefined') props[key] = value
    }
    if (Object.keys(props).length > 0) return props
  }
  return JSON5.parse(`{${ext.argument ?? ext.content}}`) // ` to "escape" syntax highlighting
}

/**
 * Encode an `object` to a `!object` inline extension
 */
function encodeObject(value: object): Extension {
  const argument = JSON5.stringify(value).slice(1, -1)
  return { type: 'inline-extension', name: 'object', argument }
}

/**
 * Interface for generic extension nodes decoded by
 * [`remark-generic-extensions`](https://github.com/medfreeman/remark-generic-extensions)
 *
 * Inline extensions have the syntax:
 *
 * ```markdown
 * !Extension[Content](Argument){Properties}
 * ```
 *
 * Block extensions have the syntax:
 *
 * ```markdown
 * Extension: Argument
 * :::
 * [Content]
 * :::
 * {Properties}
 * ```
 */
interface Extension extends UNIST.Node {
  /**
   * Type of extension
   */
  type: 'inline-extension' | 'block-extension'

  /**
   * Name of the extension
   */
  name: string

  /**
   * Content (for inline extensions this is always text [but could be decoded as Markdown])
   */
  content?: string

  /**
   * Argument string
   */
  argument?: string

  /**
   * Map of computed properties
   */
  properties?: { [key: string]: string }
}

/**
 * Decode a generic extension into an MDAST node.
 */
function decodeExtension(
  type: 'inline-extension' | 'block-extension',
  element: Extension
) {
  return { ...element, type }
}

// These `stringify*` functions are for MDAST nodes that do not
// have a stringifier (often remark plugins only support transformation
// to HAST i.e. HTML and not serialization back to Markdown).
// They transform nodes to a `MDAST.HTML` node
// so that no escaping of the value is done.
// There is a more 'official' way to do this using a `unified.Codec`
// but the docs for that are not as good as for `Decoder` and after
// several attempts, this seemed like a more expedient, short term approach.

/**
 * Encode a generic extension node into a `MDAST.HTML` node.
 *
 * The `remark-generic-extensions` plugin does not do this stringifying for us.
 */
function stringifyExtensions(tree: UNIST.Node) {
  return map(tree, (node: any) => {
    if (node.type === 'inline-extension' || node.type === 'block-extension') {
      const props = Object.entries(node.properties || {})
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ')
      let value
      if (node.type === 'inline-extension') {
        value = `!${node.name}`
        if (node.content) value += `[${node.content}]`
        if (node.argument) value += `(${node.argument})`
        if (node.properties) value += `{${props}}`
      } else {
        value = `${node.name}:`
        if (node.argument) value += ` ${node.argument}`
        value += `\n:::\n${node.content || ''}\n:::`
        if (node.properties) value += `{${props}}`
      }
      return { type: 'html', value }
    }
    return node
  })
}

const htmlCodec = new HTMLCodec()

/**
 * Decode a `MDAST.HTML` node to a Stencila `Node`
 *
 * This delegates to the `html` codec. If the HTML fragment is
 * not handled there (e.g. HTML with only non-semantic elements like `<div>`s)
 * then decode to an empty string
 */
function decodeHTML(html: MDAST.HTML): stencila.Node {
  const node = htmlCodec.decodeHtml(html.value)
  return node !== undefined ? node : ''
}

/**
 * Encode a node with `data.hProperties` into a `MDAST.HTML` node
 * with attributes in curly braces `{}`.
 *
 * The `remark-attr` plugin does not do this stringifying for us
 * (it only works with `rehype`).
 */
function stringifyAttrs(tree: UNIST.Node) {
  const types = ['heading', 'code', 'link', 'inlineCode', 'image']
  const codec = unified().use(stringifier)
  const md = (node: UNIST.Node) => codec.stringify(node)
  return map(tree, (node: UNIST.Node) => {
    if (types.includes(node.type) && node.data && node.data.hProperties) {
      const meta = stringifyMeta(
        node.data.hProperties as {
          [key: string]: string
        }
      )
      const value = `${md(node)}{${meta}}`
      return { type: 'html', value }
    }
    return node
  })
}

/**
 * Stringify a dictionary of meta data to be used as a code
 * block "infoString" or in bracketed attributes.
 */
function stringifyMeta(meta: { [key: string]: string }) {
  return Object.entries(meta)
    .map(([key, value]) => {
      let repr = key
      if (value) {
        repr += '='
        if (/\s/.test(value)) {
          repr += '"' + value + '"'
        } else {
          repr += value
        }
      }
      return repr
    })
    .join(' ')
}

/**
 * Resolve link and image references by finding the
 * associated `definition` node, using it's URL
 * and then removing it from the tree.
 */
function resolveReferences(tree: UNIST.Node): UNIST.Node {
  const definitions: { [key: string]: string } = selectAll(
    'definition',
    tree
  ).reduce((prev: { [key: string]: string }, curr: UNIST.Node) => {
    const def = curr as MDAST.Definition
    prev[def.identifier] = def.url
    return prev
  }, {})
  return filter(
    map(tree, (node: UNIST.Node) => {
      switch (node.type) {
        case 'linkReference': {
          const { identifier, children } = node as MDAST.LinkReference
          const url = definitions[identifier] || ''
          const link: MDAST.Link = { type: 'link', url, children }
          return link
        }
        case 'imageReference': {
          const { identifier, alt } = node as MDAST.ImageReference
          const url = definitions[identifier] || ''
          const image: MDAST.Image = { type: 'image', url, alt }
          return image
        }
      }
      return node
    }),
    // @ts-ignore
    (node: UNIST.Node) => node.type !== 'definition'
  ) as UNIST.Node
}
