/**
 * @module jats
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
import * as stencila from '@stencila/schema'
import crypto from 'crypto'
import fs from 'fs-extra'
import * as vfile from '../../util/vfile'
/* eslint-disable import/no-duplicates */
import * as xml from '../../util/xml'
import {
  elem,
  attr,
  attrOrUndefined,
  child,
  first,
  all,
  text,
  textOrUndefined,
  splitTextOrUndefined,
  intOrUndefined,
  Attributes
} from '../../util/xml'
import { Codec } from '../types'
import { ensureArticle } from '../../util/content/ensureArticle'
import { isDefined } from '../../util'

const log = getLogger('encoda:jats')

type Content = stencila.InlineContent | stencila.BlockContent

/**
 * The DOCTYPE to use when encoding to JATS
 */
const DOCTYPE =
  'article PUBLIC "-//NLM//DTD JATS (Z39.96) Journal Archiving and Interchange DTD v1.1 20151215//EN" "JATS-archivearticle1.dtd"'

export class JatsCodec extends Codec implements Codec {
  /**
   * Media types that this codec will match.
   *
   * There is currently no registered
   * [media type](https://www.iana.org/assignments/media-types/media-types.xhtml)
   * for JATS.
   *
   * This custom type uses the [convention](https://en.wikipedia.org/wiki/XML_and_MIME)
   * of using `application/` and the `+xml` suffix to differentiate this format from other
   * XML-based formats.
   */
  public readonly mediaTypes = ['application/jats+xml']

  /**
   * File name extensions that this codec will match.
   */
  public readonly extNames = ['jats']

  /**
   * Sniff content to see if it is JATS XML.
   *
   * For speed, rather than parsing the entire content as XML, this
   * function just uses a regex to checks if the content contains a
   * JATS DOCTYPE declaration.
   * Obviously, it's possible that a file in some other format (e.g. Markdown)
   * could contain this string.
   *
   * @param content The content to be sniffed
   */
  public readonly sniff = async (content: string): Promise<boolean> => {
    if (await fs.pathExists(content)) {
      const stat = await fs.stat(content)
      if (stat.isFile()) content = await fs.readFile(content, 'utf8')
    }
    const regex = /<!DOCTYPE\s+article\s+PUBLIC\s+"|'-\/\/NLM\/\/DTD JATS \(Z39\.96\)/
    return regex.test(content)
  }

  /**
   * Decode a `VFile` with JATS content to a Stencila `Node`.
   *
   * @param file The `VFile` to decode
   * @returns A promise that resolves to a Stencila `Node`
   */
  public readonly decode = async (
    file: vfile.VFile
  ): Promise<stencila.Article | Content[]> => {
    const jats = await vfile.dump(file)
    const doc = xml.load(jats, { compact: false }) as xml.Element
    return decodeDocument(doc)
  }

  /**
   * Encode a Stencila `Node` to a `VFile` with JATS content.
   *
   * @param thing The Stencila `Node` to encode
   * @returns A promise that resolves to a `VFile`
   */
  public readonly encode = (node: stencila.Node): Promise<vfile.VFile> => {
    const doc = encodeDocument(node)
    const jats = xml.dump(doc, { spaces: 4 })
    return Promise.resolve(vfile.load(jats))
  }
}

// The following are the functions that do the actual decoding / encoding
// As far as possible, these are as decode/encode pairs next to each other
// e.g. `decodeFigure`, `encodeFigure`, to make it easier to obtain
// bidirectional consistency.

/**
 * Decode a JATS XML document to a Stencila `Node`.
 *
 * If there is no `<article>` element then returns an array of `Content` nodes.
 */
function decodeDocument(doc: xml.Element): stencila.Article | Content[] {
  const article = first(doc, 'article')
  if (article !== null) return decodeArticle(article)

  const { elements } = doc
  if (elements === undefined) {
    log.warn('No elements in XML document')
    return []
  }

  return decodeElements(elements, initialDecodeState(doc)) as Content[]
}

/**
 * Encode a Stencila `Node` to a JATS XML document.
 *
 * If the node is not an `Article`, it will be wrapped
 * into one.
 */
function encodeDocument(node: stencila.Node): xml.Element {
  const article = ensureArticle(node)
  return {
    declaration: {
      attributes: {
        version: '1.0',
        encoding: 'utf-8'
      }
    },
    elements: [
      {
        type: 'doctype',
        doctype: DOCTYPE
      },
      encodeArticle(article)
    ]
  }
}

/**
 * It is necessary to maintain some state during decoding.
 * This interface defines that state; an instance
 * is passed down through decoding functions.
 *
 * An alternative approach would be to make the functions
 * methods of a class (e.g. the `JatsCodec` class).
 */
interface DecodeState {
  /**
   * The current `<article>` element. Used for
   * getting there target of internal references.
   */
  article: xml.Element

  /**
   * The id of the current section. Used for setting the
   * id of headings.
   */
  sectionId: string

  /**
   * The depth of the current section. Used for setting the depth
   * of headings.
   */
  sectionDepth: number
}

const initialDecodeState = (article: xml.Element): DecodeState => ({
  article,
  sectionId: '',
  sectionDepth: 0
})

/**
 * It is necessary to maintain some state during encoding.
 * This interface defines that state; an instance
 * is passed down through encoding functions.
 *
 * An alternative approach would be to make the functions
 * methods of a class (e.g. the `JatsCodec` class).
 */
interface EncodeState {
  /**
   * The current number of tables in the article.
   * Used for labelling tables.
   */
  tables: number

  /**
   * Citation elements that we have generated that need some content added to
   * them for rendering, as we can encounter citations before references.
   *
   * {bib1: elem('xref', ...)}
   */
  citations: { [rid: string]: xml.Element[] }

  /**
   * A lookup of reference ID to how they are rendered inside a citation, e.g:
   * {bib1: "Author [et al] (Year)"}
   *
   * These might be encountered before a citation that uses them, so both are
   * stored.
   */
  references: { [rid: string]: string }
}

const initialEncodeState = (): EncodeState => ({
  tables: 0,
  citations: {},
  references: {}
})

/**
 * Decode an XML element if it is defined.
 */
function decodeMaybe<Type extends stencila.Node>(
  elem: xml.Element | null | undefined,
  func: (defined: xml.Element) => Type | undefined
): Type | undefined {
  return isDefined(elem) ? func(elem) : undefined
}

/**
 * Decode a JATS `<article>` element to a Stencila `Article`.
 *
 * Extracts front- and back-matter, from `<front>` and
 * `<back>` respectively and decodes `<body>` to `content`.
 */
function decodeArticle(article: xml.Element): stencila.Article {
  const state: DecodeState = initialDecodeState(article)

  const { meta: metaFront, ...front } = decodeFront(
    child(article, 'front'),
    state
  )
  const { meta: metaBack, ...back } = decodeBack(child(article, 'back'))
  const metaAll = { ...metaFront, ...metaBack }
  const meta = Object.keys(metaAll).length > 0 ? metaAll : undefined

  const content = decodeBody(child(article, 'body'), state)

  return stencila.article({ ...front, ...back, meta, content })
}

/**
 * Encode a Stencila `Article` as a JATS `<article>`.
 */
function encodeArticle(article: stencila.Article): xml.Element {
  const {
    title = '',
    authors = [],
    description,
    content = [],
    references
  } = article

  const front = elem(
    'front',
    elem(
      'article-meta',
      encodeTitle(title),
      encodeAuthors(authors),
      encodeAbstract(description)
    )
  )

  const state: EncodeState = initialEncodeState()
  const body = encodeBody(content, state)

  const back = elem('back', ...encodeReferences(references, state))

  return elem(
    'article',
    {
      'xmlns:xlink': 'http://www.w3.org/1999/xlink',
      'article-type': 'research-article'
    },
    front,
    body,
    back
  )
}

// Front-matter related functions

/**
 * Decode a JATS `<front>` element to properties of a Stencila `Article`.
 */
function decodeFront(
  front: xml.Element | null,
  state: DecodeState
): Pick<
  stencila.Article,
  | 'authors'
  | 'editors'
  | 'datePublished'
  | 'title'
  | 'description'
  | 'isPartOf'
  | 'licenses'
  | 'keywords'
  | 'identifiers'
  | 'fundedBy'
  | 'meta'
> {
  return front === null
    ? {}
    : {
        authors: decodeAuthors(front, state),
        editors: decodeEditors(front, state),
        datePublished: decodeDatePublished(front),
        ...decodeHistory(front),
        title: decodeTitle(first(front, 'article-title'), state),
        description: decodeAbstract(first(front, 'abstract'), state),
        isPartOf: decodeIsPartOf(front),
        licenses: decodeLicenses(front, state),
        keywords: decodeKeywords(front),
        identifiers: decodeIdentifiers(front),
        fundedBy: decodeFunding(front),
        meta: decodeMetaFront(front)
      }
}

/**
 * Decode a JATS `<article-title>` element to a Stencila `Article.title`.
 */
function decodeTitle(
  title: xml.Element | null,
  state: DecodeState
): stencila.Article['title'] {
  if (title === null || title.elements === undefined) return 'Untitled'
  if (title.elements.length === 1 && title.elements[0].type === 'text')
    return text(title)
  else return decodeElements(title.elements, state)
}

/**
 * Encode a Stencila `Article.title` to a JATS `<article-group>`
 * with a nested `<article-title>` element.
 */
function encodeTitle(title: stencila.Article['title']): xml.Element {
  const articleTitle =
    typeof title === 'string'
      ? elem('article-title', title)
      : elem(
          'article-title',
          ...encodeNodes(title ?? 'Untitled', initialEncodeState())
        )
  return elem('title-group', articleTitle)
}

/**
 * Decode a JATS `<abstract>` element to a Stencila `Article.description`.
 */
function decodeAbstract(
  elem: xml.Element | null,
  state: DecodeState
): stencila.Article['description'] {
  return elem !== null ? decodeElements(all(elem, 'p'), state) : undefined
}

/**
 * Encode a Stencila `Article.description` to a JATS `<abstract>` element.
 */
function encodeAbstract(
  description?: stencila.Article['description']
): xml.Element | null {
  if (description === undefined) return null
  const paras =
    typeof description === 'string'
      ? elem('p', description)
      : elem('p', ...encodeNodes(description, initialEncodeState()))
  return elem('abstract', paras)
}

/**
 * Decode JATS `<pub-date>` elements into a Stencila `Article.datePublished` property.
 *
 * Will return the first date with `date-type==publication` or `pub-type==epub`, or
 * the first date if none of those exist.
 */
function decodeDatePublished(
  front: xml.Element
): stencila.Article['datePublished'] {
  const dates = all(front, 'pub-date')
  if (dates.length === 0) return undefined
  for (const date of dates) {
    if (
      attr(date, 'date-type') === 'publication' ||
      attr(date, 'pub-type') === 'epub'
    ) {
      return decodeDate(date)
    }
  }
  return decodeDate(dates[0])
}

/**
 * Decode a JATS `<date>` or `<pub-date>` element into a Stencila `Date`
 */
function decodeDate(date: xml.Element): stencila.Date | undefined {
  let value
  const iso = attr(date, 'iso-8601-date')
  if (iso !== null) value = iso
  else {
    const year = text(child(date, 'year'))
    if (year === null) return undefined
    value = `${year.padStart(4, '0')}`

    const month = text(child(date, 'month'))
    if (month !== null) value += `-${month.padStart(2, '0')}`

    const day = text(child(date, 'day'))
    if (day !== null) value += `-${day.padStart(2, '0')}`
  }
  return stencila.date({ value })
}

/**
 * Decode various JATS `<front>` elements (e.g. `<journal-meta>`, `<volume>`)
 * into a Stencila `Article.isPartOf` property.
 */
function decodeIsPartOf(front: xml.Element): stencila.Article['isPartOf'] {
  const journal = first(front, 'journal-meta')
  if (journal === null) return undefined

  const title = textOrUndefined(first(journal, 'journal-title'))
  const issns = all(journal, 'issn')
    .map(textOrUndefined)
    .filter(isDefined)
  const identifiers = all(journal, 'journal-id')
    .map(elem => {
      const name = attr(elem, 'journal-id-type') ?? undefined
      const propertyID = encodeIdentifierTypeUri(name)
      const value = textOrUndefined(elem)
      if (value !== undefined)
        return stencila.propertyValue({ name, propertyID, value })
    })
    .filter(isDefined)
  const publisher = textOrUndefined(first(journal, 'publisher-name'))
  const volumeNumber = textOrUndefined(first(front, 'volume'))
  return stencila.publicationVolume({
    volumeNumber,
    isPartOf: stencila.periodical({
      title,
      issns,
      identifiers,
      publisher:
        publisher !== undefined
          ? stencila.organization({ name: publisher })
          : undefined
    })
  })
}

/**
 * Decode a JATS `<permissions>` elements into a Stencila `Article.licenses` property.
 */
function decodeLicenses(
  front: xml.Element,
  state: DecodeState
): stencila.Article['licenses'] {
  const permissions = first(front, 'permissions')
  const licenses = all(permissions, 'license')
  if (licenses.length === 0) return undefined

  return licenses.reduce((prev: stencila.CreativeWork[], license) => {
    const url = attrOrUndefined(license, 'xlink:href')
    const p = first(license, 'license-p')
    const content = p !== null ? decodeParagraph(p, state) : undefined
    return [...prev, stencila.creativeWork({ url, content })]
  }, [])
}

/**
 * Decode JATS `<kwd>` elements into a Stencila `Article.keywords` property.
 */
function decodeKeywords(front: xml.Element): stencila.Article['keywords'] {
  const kwds = all(front, 'kwd')
  if (kwds.length === 0) return undefined
  return kwds.reduce((prev: string[], curr) => {
    const kwd = textOrUndefined(curr)
    return kwd !== undefined ? [...prev, kwd] : prev
  }, [])
}

/**
 * Decode JATS `<article-id>` and `<elocation-id>` elements into
 * a Stencila `Article.identifiers` property.
 */
function decodeIdentifiers(
  front: xml.Element
): stencila.Article['identifiers'] {
  return [
    ...all(front, 'article-id').map(elem => {
      const name = attr(elem, 'pub-id-type') ?? undefined
      const propertyID = encodeIdentifierTypeUri(name)
      const value = textOrUndefined(elem)
      if (value !== undefined)
        return stencila.propertyValue({
          name,
          propertyID,
          value
        })
    }),
    ...all(front, 'elocation-id').map(elem => {
      const name = 'elocation-id'
      const propertyID = encodeIdentifierTypeUri(name)
      const value = textOrUndefined(elem)
      if (value !== undefined)
        return stencila.propertyValue({
          name,
          propertyID,
          value
        })
    })
  ].filter(isDefined)
}

/**
 * Decode JATS `<funding-group>` element into a Stencila `Article.fundedBy` property.
 */
function decodeFunding(front: xml.Element): stencila.Article['fundedBy'] {
  const funding = first(front, 'funding-group')
  const awards = all(funding, 'award-group')
  if (awards.length === 0) return undefined

  return awards.map(award => {
    const identifiers = all(award, 'award-id')
      .map(id => {
        const value = textOrUndefined(id)
        if (value !== undefined) return stencila.propertyValue({ value })
      })
      .filter(isDefined)

    const funders = all(award, 'funding-source').reduce(
      (orgs: stencila.Organization[], org) => {
        // Prefer <institution>, but fallback to just text content
        let name = textOrUndefined(first(org, 'institution'))
        if (name === undefined) name = textOrUndefined(org)
        if (name === undefined) return orgs
        // Avoid duplicates
        for (const org of orgs) {
          if (org.name === name) return orgs
        }
        return [...orgs, stencila.organization({ name })]
      },
      []
    )

    return stencila.monetaryGrant({
      identifiers,
      funders
    })
  })
}

/**
 * Decode dates from the `<history>` of a JATS article into an `Article.date*` properties.
 */
function decodeHistory(
  front: xml.Element
): Pick<stencila.Article, 'dateReceived' | 'dateAccepted'> {
  const history = first(front, 'history')
  return {
    dateReceived: decodeMaybe<stencila.Date>(
      child(history, 'date', { 'date-type': 'received' }),
      decodeDate
    ),
    dateAccepted: decodeMaybe<stencila.Date>(
      child(history, 'date', { 'date-type': 'accepted' }),
      decodeDate
    )
  }
}

/**
 * Decode elements from the `<front>` of a JATS article into an `Article.meta` property.
 */
function decodeMetaFront(front: xml.Element): stencila.Article['meta'] {
  // Simply extract all footnotes withing the <author-notes> element as plain text
  const authorNotes = all(first(front, 'author-notes'), 'fn')
    .map(textOrUndefined)
    .filter(isDefined)

  return {
    authorNotes: authorNotes.length > 0 ? authorNotes : undefined
  }
}

/**
 * Decode JATS `<contrib contrib-type = "author">` elements
 * to a Stencila `Article.authors` property.
 */
function decodeAuthors(
  front: xml.Element,
  state: DecodeState
): stencila.Article['authors'] {
  const authors = all(front, 'contrib', { 'contrib-type': 'author' })
  return authors.length > 0
    ? authors.map(author => decodeContrib(author, state))
    : undefined
}

/**
 * Encode a Stencila `Article.authors` property into a JATS
 * `<contrib-group>` element.
 */
function encodeAuthors(authors: stencila.Article['authors']): xml.Element {
  const init: { auths: xml.Element[]; affs: xml.Element[] } = {
    auths: [],
    affs: []
  }
  const { auths, affs } =
    authors?.map(encodeAuthor).reduce(
      (prev, curr) => ({
        auths: [...prev.auths, curr.auth],
        affs: [...prev.affs, ...curr.affs]
      }),
      init
    ) ?? init
  return elem('contrib-group', ...auths, ...affs)
}

/**
 * Decode JATS `<contrib contrib-type = "editors">` elements
 * to a Stencila `Article.editors` property.
 */
function decodeEditors(
  front: xml.Element,
  state: DecodeState
): stencila.Article['editors'] {
  const editors = all(front, 'contrib', { 'contrib-type': 'editor' })
  return editors.length > 0
    ? editors.map(author => decodeContrib(author, state))
    : undefined
}

/**
 * Decode a JATS `<contrib>` element to a Stencila `Person` node.
 *
 * It is necessary to pass the `<article>` element to this function
 * (via `state`) so that author affiliations can be extracted.
 */
function decodeContrib(
  contrib: xml.Element,
  state: DecodeState
): stencila.Person {
  const name = child(contrib, ['name', 'string-name'])
  const person = name ? decodeName(name) : stencila.person()

  const emails = all(contrib, 'email')
  if (emails.length) person.emails = emails.map(text)

  let affiliations: stencila.Organization[] = []

  const affs = all(contrib, 'aff')
  if (affs.length > 0) {
    affiliations = [...affiliations, ...affs.map(decodeAff)]
  }

  const affRefs = all(contrib, 'xref', { 'ref-type': 'aff' })
  if (affRefs.length > 0) {
    affiliations = [
      ...affiliations,
      ...affRefs
        .map(ref => {
          const id = ref.attributes && ref.attributes.rid
          const aff = first(state.article, 'aff', { id: id })
          if (!aff) {
            log.warn(`Could not find <aff id=${id}>`)
            return null
          }
          return decodeAff(aff)
        })
        .reduce(
          (prev: stencila.Organization[], curr) =>
            curr ? [...prev, curr] : prev,
          []
        )
    ]
  }

  if (affiliations.length > 0) person.affiliations = affiliations

  return person
}

/**
 * Encode a Stencila `Person` or `Organisation` (the valid
 * node types of the `Article.authors` property) into
 * a JATS `<contrib contrib-type = "author">` element.
 */
function encodeAuthor(
  author: stencila.Person | stencila.Organization
): {
  auth: xml.Element
  affs: xml.Element[]
} {
  let name: xml.Element
  let affs: xml.Element[] = []
  if (author.type === 'Person') {
    name = encodeName(author)
    if (author.affiliations) {
      affs = author.affiliations.map(org =>
        elem(
          'aff',
          { id: crypto.randomBytes(16).toString('hex') },
          elem('institution', org.name ?? '')
        )
      )
    }
  } else {
    name = elem('string-name', author.legalName ?? author.name ?? '')
  }

  const affRefs = affs.map(aff =>
    elem('xref', {
      'ref-type': 'aff',
      rid: aff.attributes && aff.attributes.id
    })
  )
  const auth = elem('contrib', { 'contrib-type': 'author' }, name, ...affRefs)

  return { auth, affs }
}

/**
 * Decode a JATS `<name>` element into a Stencila `Person` node.
 */
function decodeName(name: xml.Element): stencila.Person {
  return stencila.person({
    givenNames: splitTextOrUndefined(child(name, 'given-names'), /\s+/),
    familyNames: splitTextOrUndefined(child(name, 'surname'), /\s+/),
    honorificPrefix: textOrUndefined(child(name, 'prefix')),
    honorificSuffix: textOrUndefined(child(name, 'suffix'))
  })
}

/**
 * Encode a Stencila `Person` node into a JATS `<name>` element
 * or `<string-name>` element.
 */
function encodeName(person: stencila.Person): xml.Element {
  if (person.familyNames || person.givenNames) {
    return elem(
      'name',
      person.familyNames ? elem('surname', person.familyNames.join(' ')) : null,
      person.givenNames
        ? elem('given-names', person.givenNames.join(' '))
        : null,
      person.honorificPrefix ? elem('prefix', person.honorificPrefix) : null,
      person.honorificSuffix ? elem('suffix', person.honorificSuffix) : null
    )
  } else {
    return elem('string-name', person.name ?? '')
  }
}

/**
 * Decode a JATS `<aff>` element into a Stencila `Organization` node.
 */
function decodeAff(aff: xml.Element): stencila.Organization {
  let name = textOrUndefined(child(aff, 'institution'))
  let addressComponents = all(aff, [
    'addr-line',
    'city',
    'state',
    'country',
    'postal-code'
  ])
  const url = textOrUndefined(child(aff, 'uri'))

  // Sometimes there is no `<institution>` element and `<addr-line>` is
  // used for name and address combined. So use the first `addressComponents`
  // as name if needed.
  if (name === undefined && addressComponents.length > 0) {
    const [first, ...rest] = addressComponents
    name = text(first)
    addressComponents = rest
  }

  return stencila.organization({
    name,
    url,
    address: addressComponents.length
      ? addressComponents.map(text).join(', ')
      : undefined
  })
}

// Back-matter related functions

/**
 * Decode a JATS `<back>` element into properties of a Stencila `Article`
 */
function decodeBack(
  back: xml.Element | null
): Pick<stencila.Article, 'references' | 'meta'> {
  if (back === null) return {}
  const references = decodeReferences(first(back, 'ref-list'))
  return { references }
}

/**
 * Decode a JATS `<ref-list>` element to a Stencila `Article.reference`
 * property.
 */
function decodeReferences(
  elem: xml.Element | null
): stencila.Article['references'] {
  if (elem === null) return undefined

  const refs = all(elem, 'ref')
  return refs
    .map(ref => {
      const citation = child(ref, ['element-citation', 'mixed-citation'])
      return citation ? decodeReference(citation, attr(ref, 'id')) : null
    })
    .reduce(
      (prev: stencila.CreativeWork[], curr) => (curr ? [...prev, curr] : prev),
      []
    )
}

/**
 * Encode a Stencila `Article.references` property to a
 * JATS `<ref-list>` element.
 *
 * @returns A array with a single `<ref-list>` element
 * if the article has references, otherwise an empty array.
 */
function encodeReferences(
  references: stencila.Article['references'],
  state: EncodeState
): xml.Element[] {
  return references === undefined
    ? []
    : [
        elem(
          'ref-list',
          elem('title', 'References'),
          ...references.map(ref => encodeReference(ref, state))
        )
      ]
}

/**
 * Decode a JATS `<element-citation>` or `<mixed-citation>` element
 * into a Stencila `CreativeWork`.
 */
function decodeReference(
  elem: xml.Element,
  id?: string | null
): stencila.CreativeWork {
  const rawAuthors = all(elem, 'name')
  const authors = rawAuthors.length ? rawAuthors.map(decodeName) : []
  const title = text(child(elem, 'article-title'))
  const work = stencila.article({ authors, title })

  const year = child(elem, 'year')
  if (year) {
    const iso = attr(year, 'iso-8601-date')
    work.datePublished = iso ?? text(year)
    // TODO: warn that the date components apart from year are lost?
    // Or also parse month and day
  }

  const source = child(elem, 'source')
  if (source) {
    const issueEl = child(elem, 'issue')
    if (issueEl) {
      work.isPartOf = stencila.publicationIssue({
        issueNumber: intOrUndefined(child(elem, 'issue')),
        pageStart: intOrUndefined(child(elem, 'fpage')),
        pageEnd: intOrUndefined(child(elem, 'lpage')),
        isPartOf: stencila.publicationVolume({
          title: text(source),
          volumeNumber: intOrUndefined(child(elem, 'volume'))
        })
      })
    } else {
      work.isPartOf = stencila.publicationVolume({
        pageStart: intOrUndefined(child(elem, 'fpage')),
        pageEnd: intOrUndefined(child(elem, 'lpage')),
        title: text(source),
        volumeNumber: intOrUndefined(child(elem, 'volume'))
      })
    }
  }

  if (id) work.id = decodeInternalId(id)

  return work
}

/**
 * Encode a Stencila `Article.references` item as a JATS `<ref>`
 * element,
 */
function encodeReference(
  work: stencila.CreativeWork | string,
  state: EncodeState
): xml.Element {
  let citation, rid
  if (typeof work === 'string') {
    return elem('ref')
  } else {
    rid = work.id
    const subElements = []

    const { title, authors, datePublished } = work

    if (title) subElements.push(elem('article-title', ...encodeNodes(title)))

    if (authors?.length) {
      const people = authors.filter(stencila.isType('Person')).map(encodeName)

      const personGroup = elem(
        'person-group',
        { 'person-group-type': 'author' },
        ...people
      )

      if (rid && state.references[rid] === undefined) {
        state.references[rid] = encodeCitationText(work)
        populateBibrContent(rid, state)
      }

      subElements.push(personGroup)
    }

    // TODO: split date into components according to what data is set and apply to appropriate elements
    if (datePublished) {
      subElements.push(
        elem(
          'year',
          {
            'iso-8601-date':
              typeof datePublished === 'string'
                ? datePublished
                : datePublished.value
          },
          datePublished
        )
      )
    }

    if (stencila.isA('PublicationIssue', work.isPartOf)) {
      const pi = work.isPartOf

      if (pi.pageStart !== undefined) {
        subElements.push(elem('fpage', `${pi.pageStart}`))
      }

      if (pi.pageEnd !== undefined) {
        subElements.push(elem('lpage', `${pi.pageEnd}`))
      }

      if (pi.issueNumber !== undefined) {
        subElements.push(elem('issue', `${pi.issueNumber}`))
      }

      if (stencila.isA('PublicationVolume', pi.isPartOf)) {
        const pv = pi.isPartOf

        if (pv.title !== undefined)
          subElements.push(elem('source', ...encodeNodes(pv.title)))

        if (pv.volumeNumber !== undefined) {
          subElements.push(elem('volume', `${pv.volumeNumber}`))
        }
      }
    } else if (stencila.isA('PublicationVolume', work.isPartOf)) {
      const pv = work.isPartOf

      if (pv.title !== undefined)
        subElements.push(elem('source', ...encodeNodes(pv.title)))

      if (pv.pageStart !== undefined) {
        subElements.push(elem('fpage', `${pv.pageStart}`))
      }

      if (pv.pageEnd !== undefined) {
        subElements.push(elem('lpage', `${pv.pageEnd}`))
      }

      if (pv.volumeNumber !== undefined) {
        subElements.push(elem('volume', `${pv.volumeNumber}`))
      }
    }

    citation = elem('element-citation', null, ...subElements)

    return elem('ref', { id: rid }, citation)
  }
}

/**
 * Create text used to cite a Stencila `CreativeWork` within
 * the content of an `Article`.
 */
function encodeCitationText(work: stencila.CreativeWork): string {
  const { authors, datePublished } = work
  let citeText = ''

  if (authors?.length) {
    const people = authors.filter(p => stencila.isA('Person', p))

    if (people.length) {
      const firstPerson = people[0] as stencila.Person
      let secondPerson

      if (firstPerson.familyNames) {
        citeText += firstPerson.familyNames.join(' ')

        if (people.length === 2) {
          secondPerson = people[1] as stencila.Person
          if (secondPerson.familyNames)
            citeText += 'and ' + secondPerson.familyNames.join(' ')
        } else if (people.length > 2) {
          citeText += ' et al.'
        }
      }
    }
  }

  if (datePublished !== undefined) {
    const date =
      typeof datePublished === 'string' ? datePublished : datePublished.value
    const publishedYear = date.split('-')[0]
    citeText += `, ${publishedYear}`
  }

  return citeText
}

// Functions for decoding / encoding content in article body
// These functions generally return an array of nodes or elements,
// usually only containing one or zero item. This provides some
// convenience by being able to de-structure the returned array
// instead of having to check for undefined.

/**
 * Decode the JATS `<body>` element to an array of Stencila `Node`s
 */
function decodeBody(
  body: xml.Element | null,
  state: DecodeState
): stencila.Article['content'] {
  return body === null ? undefined : decodeDefault(body, state)
}

/**
 * Encode an array of Stencila `Node`s to a JATS `<body>` element
 */
function encodeBody(nodes: stencila.Node[], state: EncodeState): xml.Element {
  const sections: xml.Element[] = []
  let section: xml.Element | undefined
  for (const node of nodes) {
    if (stencila.nodeType(node) === 'Heading') {
      section = elem('sec')
      sections.push(section)
    }
    const el = encodeNode(node, state)
    if (!section) {
      section = elem('sec')
      sections.push(section)
    }
    if (section.elements) section.elements.push(...el)
  }
  return elem('body', ...sections)
}

/**
 * Decode a JATS element to an array of Stencila `Node`s
 */
function decodeElement(elem: xml.Element, state: DecodeState): stencila.Node[] {
  if (elem.type === 'text') return [elem.text ?? '']
  switch (elem.name) {
    case 'sec':
      return decodeSection(elem, state)
    case 'title':
      return decodeHeading(elem, state)
    case 'p':
      return decodeParagraph(elem, state)
    case 'list':
      return decodeList(elem, state)
    case 'table-wrap':
      return decodeTableWrap(elem, state)
    case 'ext-link':
      return decodeExtLink(elem, state)
    case 'inline-graphic':
      return decodeGraphic(elem, true)
    case 'graphic':
      return decodeGraphic(elem, false)
    case 'media':
      return decodeMedia(elem)
    case 'xref':
      return decodeXRef(elem, state)
    case 'italic':
      return decodeMark(elem, state, 'Emphasis')
    case 'bold':
      return decodeMark(elem, state, 'Strong')
    case 'sup':
      return decodeMark(elem, state, 'Superscript')
    case 'sub':
      return decodeMark(elem, state, 'Subscript')
    case 'inline-formula':
    case 'disp-formula':
      return decodeMath(elem)
    case 'break':
      return decodeBreak()
    case 'fig':
      return decodeFigure(elem, state)
    case 'fig-group':
      return decodeFigGroup(elem, state)
    case 'code':
      return decodeCode(elem)
    default:
      log.warn(`Using default decoding for JATS element name: "${elem.name}"`)
      return decodeDefault(elem, state)
  }
}

/**
 * Encode a Stencila `Node` as an array of JATS elements
 */
function encodeNode(node: stencila.Node, state: EncodeState): xml.Element[] {
  switch (stencila.nodeType(node)) {
    case 'Heading':
      return encodeHeading(node as stencila.Heading, state)
    case 'Paragraph':
      return encodeParagraph(node as stencila.Paragraph, state)
    case 'List':
      return encodeList(node as stencila.List, state)
    case 'Table':
      return encodeTable(node as stencila.Table, state)
    case 'Link':
      return encodeLink(node as stencila.Link, state)
    case 'Emphasis':
      return encodeMark(node as stencila.Emphasis, state, 'italic')
    case 'Strong':
      return encodeMark(node as stencila.Strong, state, 'bold')
    case 'Superscript':
      return encodeMark(node as stencila.Superscript, state, 'sup')
    case 'Subscript':
      return encodeMark(node as stencila.Subscript, state, 'sub')
    case 'MathFragment':
    case 'MathBlock':
      return encodeMath(node as stencila.Math)
    case 'Figure':
      return encodeFigure(node as stencila.Figure, state)
    case 'ImageObject': {
      const im = node as stencila.ImageObject
      return encodeMedia(
        im,
        im.meta && im.meta.inline ? 'inline-graphic' : 'graphic'
      )
    }
    case 'MediaObject':
      return encodeMedia(node as stencila.ImageObject, 'media')
    case 'Cite':
      return encodeCite(node as stencila.Cite, state)
    case 'Text':
      return [{ type: 'text', text: node as string }]
    case 'Collection': {
      const collection = node as stencila.Collection
      if (collection.meta && collection.meta.usage === 'figGroup') {
        return encodeFigGroup(collection, state)
      }
    }
    // fallthrough expected if not a figGroup
    default:
      log.warn(
        `Unhandled node type when encoding to JATS: "${stencila.nodeType(
          node
        )}"`
      )
      return []
  }
}

/**
 * The default decoding function for JATS elements.
 * Decodes the child elements to an array of Stencila `Node`s
 */
function decodeDefault(elem: xml.Element, state: DecodeState): stencila.Node[] {
  return elem.elements !== undefined ? decodeElements(elem.elements, state) : []
}

/**
 * The default encoding function for an array of Stencila nodes.
 */
function encodeDefault(
  name: string,
  nodes: stencila.Node[],
  state: EncodeState
): xml.Element {
  return elem(name, ...encodeNodes(nodes, state))
}

/**
 * Decode an array of JATS elements to an array of Stencila nodes.
 */
function decodeElements(
  elems: xml.Element[],
  state: DecodeState
): stencila.Node[] {
  return elems
    .map(child => decodeElement(child, state))
    .reduce((prev, curr) => [...prev, ...curr], [])
}

/**
 * Encode an array of Stencila nodes to an array of JATS elements.
 */
function encodeNodes(
  nodes: stencila.Node | stencila.Node[],
  state: EncodeState = initialEncodeState()
): xml.Element[] {
  if (!Array.isArray(nodes)) nodes = [nodes]
  return nodes
    .map((node: stencila.Node) => encodeNode(node, state))
    .reduce(
      (prev: xml.Element[], curr: xml.Element[]) => [...prev, ...curr],
      []
    )
}

/**
 * Decode and array of JATS elements, ensuring the returned
 * results are only Stencila `InlineContent` nodes.
 */
function decodeInlineContent(
  elems: xml.Element[],
  state: DecodeState
): stencila.InlineContent[] {
  return decodeElements(elems, state).filter(stencila.isInlineContent)
}

/**
 * Decode a JATS `<section>` element.
 *
 * This increments the `sectionId` and `sectionDepth` state variables
 * so that they can be applied to heading nodes (decoded from `<title>` elements).
 * It is necessary to retain `id` attributes so that any internal links are maintained.
 */
function decodeSection(elem: xml.Element, state: DecodeState): stencila.Node[] {
  const sectionId = attr(elem, 'id') ?? ''
  const { sectionDepth, ...rest } = state
  return decodeDefault(elem, {
    ...rest,
    sectionId,
    sectionDepth: sectionDepth + 1
  })
}

/**
 * Decode a JATS section `<title>` to a Stencila `Heading`.
 */
function decodeHeading(
  elem: xml.Element,
  state: DecodeState
): [stencila.Heading] {
  return [
    stencila.heading({
      content: decodeInlineContent(elem.elements ?? [], state),
      depth: state.sectionDepth,
      id: state.sectionId
    })
  ]
}

/**
 * Encode a Stencila `Heading` to a JATS section `<title>`.
 */
function encodeHeading(
  node: stencila.Heading,
  state: EncodeState
): [xml.Element] {
  return [encodeDefault('title', node.content, state)]
}

/**
 * Decode a JATS `<p>` element to an array of Stencila block
 * content nodes.
 *
 * This function handles the 'breaking apart' of a paragraph
 * when an element inside it is decoded to block content
 */
function decodeParagraph(
  elem: xml.Element,
  state: DecodeState
): stencila.Node[] {
  const nodes = decodeElements(elem.elements ?? [], state)
  let para: stencila.Paragraph | undefined = stencila.paragraph({ content: [] })
  const blocks: stencila.Node[] = []
  for (const node of nodes) {
    if (stencila.isInlineContent(node)) {
      if (para === undefined) para = stencila.paragraph({ content: [node] })
      else para.content.push(node)
    } else {
      if (para !== undefined) {
        blocks.push(para)
        para = undefined
      }
      blocks.push(node)
    }
  }
  if (para !== undefined) blocks.push(para)
  return blocks
}

/**
 * Encode a Stencila `Paragraph` node as a JATS `<p>` element.
 */
function encodeParagraph(
  node: stencila.Paragraph,
  state: EncodeState
): [xml.Element] {
  return [encodeDefault('p', node.content, state)]
}

/**
 * Decode JATS `<ext-link>` element to a Stencila `Link`.
 */
function decodeExtLink(elem: xml.Element, state: DecodeState): [stencila.Link] {
  return [
    stencila.link({
      content: decodeInlineContent(elem.elements ?? [], state),
      target: attr(elem, 'xlink:href') ?? ''
    })
  ]
}

/**
 * Encode a Stencila `Link` node as a JATS `<ext-link>` element.
 */
function encodeLink(node: stencila.Link, state: EncodeState): [xml.Element] {
  return [
    elem(
      'ext-link',
      {
        'ext-link-type': 'uri',
        'xlink:href': node.target
      },
      ...encodeNodes(node.content, state)
    )
  ]
}

/**
 * Decode a JATS `<xref>` element to a Stencila `Link`, or `Cite` node
 * (depending on its use).
 *
 * The `rid` attribute is decoded to a local `Link`.
 * The `ref-type` attribute is preserved in the link's `relation` property, or
 * discarded if decoding to a `Cite` (in the case of "bibr").
 * See https://jats.nlm.nih.gov/archiving/tag-library/1.1/element/xref.html
 */
function decodeXRef(
  elem: xml.Element,
  state: DecodeState
): [stencila.Link | stencila.Cite] {
  return attr(elem, 'ref-type') === 'bibr'
    ? decodeBibr(elem, state)
    : decodeLink(elem, state)
}

/**
 * Decode a JATS internal identifier.
 *
 * This function normalises ids so that if can not be confused with a URL.
 * This is necessary for issues such as [this](https://github.com/stencila/encoda/pull/399#issuecomment-580391161)
 * where a `rid` "looked like" a URL and so was treated as such.
 * The [`rid` (reference to an identifer)](https://jats.nlm.nih.gov/archiving/tag-library/1.1/attribute/rid.html)
 * attribute is intended to be used for internal identifiers within the document.
 */
function decodeInternalId(id: string | null): string {
  if (id === null) {
    log.error(`Id is null`)
    return ''
  }
  return id.replace(/\./g, '-')
}

/**
 * Decode a JATS `<xref>` element to a Stencila `Link`.
 */
function decodeLink(elem: xml.Element, state: DecodeState): [stencila.Link] {
  return [
    stencila.link({
      content: decodeDefault(elem, state).filter(stencila.isInlineContent),
      target: `#${decodeInternalId(attr(elem, 'rid'))}`,
      relation: attrOrUndefined(elem, 'ref-type')
    })
  ]
}

/**
 * Decode a JATS `<xref ref-type="bibr">` element to a Stencila `Cite` node.
 *
 * Decode the content of the citation e.g `Smith et al (1990)` but note that this
 * may be replaced by other content during encoding.
 * Reciprocal function of this is `encodeCite`.
 */
function decodeBibr(elem: xml.Element, state: DecodeState): [stencila.Cite] {
  return [
    stencila.cite({
      content: decodeDefault(elem, state).filter(stencila.isInlineContent),
      target: decodeInternalId(attr(elem, 'rid'))
    })
  ]
}

/**
 * Encode a Stencila `Cite` node as a JATS `<xref>` element.
 */
function encodeCite(cite: stencila.Cite, state: EncodeState): [xml.Element] {
  const rid = cite.target.startsWith('#')
    ? cite.target.substring(1)
    : cite.target

  const xref = elem('xref', { rid, 'ref-type': 'bibr' })

  if (state.citations[rid] === undefined) {
    state.citations[rid] = []
  }

  state.citations[rid].push(xref)

  populateBibrContent(rid, state)

  return [xref]
}

/**
 * Check if we have both a reference and its citation, if so, apply the
 * reference content to the citation node
 */
function populateBibrContent(rid: string, state: EncodeState): void {
  if (state.citations[rid] === undefined) return // no elements to populate

  if (state.references[rid] === undefined) return // no refs to use to populate

  state.citations[rid].forEach((xref: xml.Element) => {
    if (xref.elements === undefined) {
      xref.elements = []
    }

    if (xref.elements.length === 0) {
      xref.elements.push({ type: 'text', text: state.references[rid] })
    }
  })
}

/**
 * Deocde a JATS `<italic>`, `<bold>` etc node as a Stencila `Mark` node
 * of `Type` e.g. `Strong`.
 */
function decodeMark<Type extends keyof typeof stencila.markTypes>(
  elem: xml.Element,
  state: DecodeState,
  type: Type
): stencila.Mark[] {
  return [
    {
      type: type,
      content: decodeInlineContent(elem.elements ?? [], state)
    }
  ]
}

/**
 * Encode a Stencila `Mark` node to a JATS element.
 */
function encodeMark(
  node: stencila.Mark,
  state: EncodeState,
  name: string
): [xml.Element] {
  return [elem(name, ...encodeNodes(node.content, state))]
}

/**
 * Deocde a JATS `<list>` element to a Stencila `List` node.
 */
function decodeList(elem: xml.Element, state: DecodeState): [stencila.List] {
  const type = attr(elem, 'list-type')
  const order =
    type === 'bullet' || type === 'simple' ? 'unordered' : 'ascending'
  const items = all(elem, 'list-item').map(
    (item): stencila.ListItem => {
      return stencila.listItem({
        content: decodeElements(item.elements ?? [], state)
      })
    }
  )
  return [stencila.list({ items, order })]
}

/**
 * Encode a Stencila `List` node as a JATS `<list>` element.
 */
function encodeList(node: stencila.List, state: EncodeState): [xml.Element] {
  const attrs = {
    'list-type': node.order === 'unordered' ? 'bullet' : 'order'
  }
  const items = node.items.map(item => {
    return elem('list-item', ...encodeNodes(item.content, state))
  })
  return [elem('list', attrs, ...items)]
}

/**
 * Decode a JATS `<table-wrap>` element to a Stencila `Table` node.
 */
function decodeTableWrap(
  elem: xml.Element,
  state: DecodeState
): [stencila.Table] {
  const table = stencila.table({ rows: [] })

  const id = attr(elem, 'id')
  if (id) table.id = id

  const caption = child(elem, 'caption')
  if (caption) {
    const title = child(caption, 'title')
    if (title) table.title = text(title)

    const content = caption.elements
      ? caption.elements.filter(child => child !== title)
      : []
    if (content) table.content = content
  }

  const rows = all(elem, 'tr')
  if (rows.length) {
    table.rows = rows.map(row => {
      return stencila.tableRow({
        cells: all(row, ['td', 'th']).map(cell => {
          return stencila.tableCell({
            content: decodeInlineContent(cell.elements ?? [], state)
          })
        })
      })
    })
  }

  return [table]
}

/**
 * Encode a Stencila `Table` node as a JATS `<table-wrap>` element.
 */
function encodeTable(node: stencila.Table, state: EncodeState): [xml.Element] {
  state.tables += 1

  const attrs = node.id ? { id: node.id } : {}

  const label = elem('label', `Table ${state.tables}.`)

  const caption = elem(
    'caption',
    node.title ? elem('title', ...encodeNodes(node.title)) : null
  )

  const rows = node.rows.map(row => {
    return elem(
      'tr',
      ...row.cells.map(cell => {
        return encodeDefault('tr', cell.content, state)
      })
    )
  })

  const table = elem('table', elem('tbody', ...rows))

  return [elem('table-wrap', attrs, label, caption, table)]
}

/**
 * Decode a JATS `<fig-group>` element as a Stencila `Collection`.
 */
function decodeFigGroup(
  elem: xml.Element,
  state: DecodeState
): [stencila.Collection] {
  return [
    stencila.collection({
      parts: all(elem, 'fig').map(figEl => {
        return decodeFigure(figEl, state)[0]
      }),
      meta: { usage: 'figGroup' }
    })
  ]
}

/**
 * Encode a Stencila `Collection` of `Figure` nodes as a JATS `<fig-group>` element.
 */
function encodeFigGroup(
  figGroup: stencila.Collection,
  state: EncodeState
): [xml.Element] {
  return [
    elem(
      'fig-group',
      ...figGroup.parts
        .filter(stencila.isType('Figure'))
        .map(figure => encodeFigure(figure, state)[0])
    )
  ]
}

/**
 * Decode a JATS `<fig>` element to a Stencila `Figure` node.
 *
 * Uses the `<alternatives>` element as content, if it exists, otherwise the first
 * valid child e.g. `<graphic>`.
 */
function decodeFigure(
  elem: xml.Element,
  state: DecodeState
): [stencila.Figure] {
  const caption = child(elem, 'caption')

  const alternatives = child(elem, 'alternatives')
  let content
  if (alternatives !== null) content = decodeDefault(alternatives, state)
  else {
    const item = child(elem, [
      'disp-formula',
      'disp-formula-group',
      'chem-struct-wrap',
      'disp-quote',
      'speech',
      'statement',
      'verse-group',
      'table-wrap',
      'p',
      'def-list',
      'list',
      'array',
      'code',
      'graphic',
      'media',
      'preformat'
    ])
    content = item !== null ? decodeElement(item, state) : undefined
  }

  return [
    stencila.figure({
      id: attrOrUndefined(elem, 'id'),
      label: textOrUndefined(child(elem, 'label')),
      caption: caption?.elements?.length
        ? decodeElements(caption.elements, state)
        : undefined,
      content
    })
  ]
}

/**
 * Encode a Stencila `Figure` node as a JATS `<fig>` element.
 *
 * If there are multiple content elements, they will be grouped
 * in an `<alternatives>` element.
 */
function encodeFigure(
  figure: stencila.Figure,
  state: EncodeState
): [xml.Element] {
  const { label, caption, content = [] } = figure
  const children = encodeNodes(content)
  return [
    elem(
      'fig',
      label !== undefined ? elem('label', label) : null,
      caption !== undefined
        ? elem('caption', ...encodeNodes(caption, state))
        : null,
      children.length === 0
        ? null
        : children.length === 1
        ? children[0]
        : elem('alternatives', ...children)
    )
  ]
}

/**
 * Decode a JATS `<inline-formula>` or `<disp-formula>` element to a
 * Stencila `MathFragment`, `MathBlock` or `ImageObject` node.
 *
 * This function preferentially uses `<mml:math>` but, if that is
 * not available, uses an image as an alternative (which is wrapped in
 * a paragraph for display formulas).
 */
function decodeMath(
  formula: xml.Element
): (stencila.Math | stencila.ImageObject | stencila.Paragraph)[] {
  const inline = formula.name === 'inline-formula'
  const mathml = first(formula, 'mml:math')

  if (mathml === null) {
    const graphic = first(formula, ['graphic', 'inline-graphic'])
    if (graphic === null) return []
    const image = decodeGraphic(graphic, inline)
    return inline ? image : [stencila.paragraph({ content: image })]
  }

  // Wrapper is needed to dump the entire math element
  const text = xml.dump(elem('wrapper', mathml))
  return [
    (inline ? stencila.mathFragment : stencila.mathBlock)({
      mathLanguage: 'mathml',
      text
    })
  ]
}

/**
 * Encode a Stencila `Math` node as a JATS `<mml:math>` element.
 */
function encodeMath(math: stencila.Math): xml.Element[] {
  const { mathLanguage, text = '' } = math

  if (mathLanguage !== 'mathml') log.error(`Only MathML is supported`)

  try {
    const root = xml.load(text, { compact: false }) as xml.Element
    if (root?.elements?.length) return [root.elements[0]]
  } catch (error) {
    log.error(`Error parsing MathML:\n${error.message}\n${text}`)
  }
  return []
}

/**
 * Decode a JATS `<break>` element into a space.
 *
 * The `break` element is "An explicit line break in the text."
 * At present, this is assumed not to imply any semantic meaning
 * as is decoded to a space.
 */
function decodeBreak(): [string] {
  return [' ']
}

/**
 * Get the `mimetype` and `mime-subtype` from an element and return it in a
 * traditional `type/subtype` string.
 */
function extractMimetype(elem: xml.Element): string {
  const mimetype = attr(elem, 'mimetype') ?? ''

  const mimeSubtype = attr(elem, 'mime-subtype') ?? ''

  const joiner = mimetype.length && mimeSubtype.length ? '/' : ''

  return mimetype + joiner + mimeSubtype
}

/**
 * Extract the `format` string from `media`, split it into the attributes that
 * JATS requires, then set them on `attrs`
 */
function applyMimetype(media: stencila.MediaObject, attrs: Attributes): void {
  if (media.format === undefined || media.format.length === 0) {
    return
  }

  const jatsType = splitMimetype(media.format)
  if (jatsType.mimetype) {
    attrs.mimetype = jatsType.mimetype
  }
  if (jatsType.mimeSubtype) {
    attrs['mime-subtype'] = jatsType.mimeSubtype
  }
}

/**
 * Interface to reflect how
 * JATS splits the media type into two sections
 */
interface JatsContentType {
  mimetype?: string
  mimeSubtype?: string
}

/**
 * Split a traditional `type/subtype` MIME string into a `JatsContentType`.
 */
function splitMimetype(mimetype: string): JatsContentType {
  const splitType = mimetype.split('/')

  return {
    mimetype: splitType[0].length ? splitType[0] : undefined,
    mimeSubtype: splitType.length > 1 ? splitType[1] : undefined
  }
}

/**
 * Decode a `<graphic>` element to an ImageObject. There is no corresponding
 * `encodeGraphic` function, use `encodeMedia` with `'graphic'` argument.
 */
function decodeGraphic(
  elem: xml.Element,
  inline: boolean
): [stencila.ImageObject] {
  const meta: { [key: string]: any } = { inline }

  const linkType = attr(elem, 'xlink:type')
  if (linkType) meta.linkType = linkType

  const usage = attr(elem, 'specific-use')
  if (usage) meta.usage = usage

  return [
    stencila.imageObject({
      contentUrl: attr(elem, 'xlink:href') ?? '',
      format: extractMimetype(elem),
      meta: meta
    })
  ]
}

/**
 * Decode a JATS `<media>` element to a Stencila `MediaObject` node.
 */
function decodeMedia(elem: xml.Element): [stencila.MediaObject] {
  return [
    stencila.mediaObject({
      contentUrl: attr(elem, 'xlink:href') ?? '',
      format: extractMimetype(elem)
    })
  ]
}

/**
 * Encode a Stencila `MediaObject` as a JATS element e.g. `<graphic>`
 */
function encodeMedia(
  media: stencila.MediaObject,
  elementName: string
): [xml.Element] {
  const attrs: Attributes = {
    'xlink:href': media.contentUrl
  }

  if (media.meta && media.meta.usage) {
    attrs['specific-use'] = media.meta.usage
  }

  if (media.meta && media.meta.linkType) {
    attrs['xlink:type'] = media.meta.linkType
  }

  applyMimetype(media, attrs)

  return [elem(elementName, attrs)]
}

/**
 * Decode a JATS `<code>` element as a Stencila `CodeBlock`.
 */
function decodeCode(elem: xml.Element): [stencila.CodeBlock] {
  return [
    stencila.codeBlock({
      text: text(elem),
      programmingLanguage: attr(elem, 'language') ?? undefined
    })
  ]
}

/**
 * Encode the name of an identifier type to a URI for use on
 * a `propertyID` property.
 *
 * See [this](https://github.com/ESIPFed/science-on-schema.org/issues/13#issuecomment-577446582)
 * which recommends:
 *
 *   > a schema:propertyId for each identifier that links back to the identifier scheme using
 *   > URIs drawn from the http://purl.org/spar/datacite/IdentifierScheme vocabulary or from
 *   > identifiers.org registered prefixes from https://registry.identifiers.org/registry
 */
function encodeIdentifierTypeUri(name?: string): string | undefined {
  if (name === undefined) return undefined
  return `https://registry.identifiers.org/registry/${name}`
}
