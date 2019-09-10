import stencila from '@stencila/schema'
import { JatsCodec } from '../jats'
import * as xml from '../../util/xml'
import * as http from '../../util/http'
import * as vfile from '../../util/vfile'
import { Codec } from '../types'
import fs from 'fs-extra'
import path from 'path'
import tempy from 'tempy'

const jats = new JatsCodec()

export class PlosCodec extends Codec implements Codec {
  private static regex = /^\s*((doi\s*:?\s*)|(https?:\/\/doi.org\/)|(https:\/\/journals\.plos\.org\/([a-z]+)\/article\?id=))?(10\.1371\/journal\.([a-z]+)\.\d+)\s*$/i

  public readonly sniff = async (content: string): Promise<boolean> => {
    return PlosCodec.regex.test(content)
  }

  /**
   * Decode a PLoS article identifier (e.g. URL or DOI) to
   * the journal and DOI components.
   */
  public readonly decodeIdentifier = (
    identifier: string
  ): {
    journal: string
    doi: string
  } => {
    const match = identifier.match(PlosCodec.regex)
    if (!match)
      throw new Error(`Unable to parse identifier as PLoS DOI: "${identifier}"`)

    const doi = match[6]
    const journal = ((code: string) => {
      switch (code) {
        case 'pbio':
          return 'plosbiology'
        case 'pcbi':
          return 'ploscompbiol'
        case 'pgen':
          return 'plosgenetics'
        case 'pmed':
          return 'plosmedicine'
        case 'pntd':
          return 'plosntds'
        case 'pone':
          return 'plosone'
        case 'ppat':
          return 'plospathogens'
      }
      throw new Error(`Unrecognised PLoS journal: "${code}"`)
    })(match[7])

    return { journal, doi }
  }

  public readonly decode = async (
    file: vfile.VFile
  ): Promise<stencila.Node> => {
    const content = await vfile.dump(file)
    const { journal, doi } = this.decodeIdentifier(content)

    const url = `http://journals.plos.org/${journal}/article/file?id=${doi}&type=manuscript`
    const response = await http.get(url)
    const jatsContent = response.body
    const doc = xml.load(jatsContent, { compact: false }) as xml.Element

    const dir = tempy.directory()
    await fs.ensureDir(dir)

    // Get the figures and rewrite hrefs
    const graphics = xml.all(doc, 'graphic')
    for (const graphic of graphics) {
      const href = xml.attr(graphic, 'xlink:href')
      if (href !== null && href.startsWith(`info:doi/${doi}`)) {
        const id = href.split('.').pop() || ''
        const url =
          `https://journals.plos.org/${journal}/article/` +
          (id.startsWith('e')
            ? // Equation
              `file?id=info:doi/${doi}.${id}&type=thumbnail`
            : // Eveything else
              `figure/image?id=${doi}.${id}&size=medium`)
        const filename = `${id}.png`
        const filepath = path.join(dir, filename)
        await http.download(url, filepath)
        if (graphic.attributes !== undefined) {
          graphic.attributes['xlink:href'] = filepath
          graphic.attributes['mime-subtype'] = 'png'
        }
      }
    }

    // Dump the new JATS with `xlink:href`s to local images
    const jatsNew = xml.dump(doc)
    return jats.decode(vfile.load(jatsNew))
  }

  public readonly encode = async (): Promise<vfile.VFile> => {
    throw new Error(`Encoding to a PLoS article is not yet implemented`)
  }
}