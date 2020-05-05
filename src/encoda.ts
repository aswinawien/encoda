import {
  Capabilities,
  cli,
  Listener,
  Server,
  StdioServer,
} from '@stencila/executa'
import { getLogger } from '@stencila/logga'
import * as schema from '@stencila/schema'
import { codecList, decode, encode } from '.'
import { commonEncodeDefaults } from './codecs/types'
import * as vfile from './util/vfile'

const log = getLogger('encoda')

/**
 * An Executa `Listener` which by default listens
 * on `stdio` to expose the `decode` and `encode`
 * functions.
 */
export class Encoda extends Listener {
  constructor(
    servers: Server[] = [
      new StdioServer({ command: 'node', args: [__filename, 'start'] }),
    ]
  ) {
    super('en', servers)
  }

  /**
   * @override Override of `Executor.capabilities` to
   * define Encoda specific capabilities.
   */
  public capabilities(): Promise<Capabilities> {
    return Promise.resolve({
      manifest: true,
      decode: {
        // Format is not required (it can be inferred from source)
        // but if specified, then must be part of the list
        required: ['source'],
        properties: {
          source: {
            type: 'string',
          },
          format: {
            enum: codecList,
          },
        },
      },
      encode: {
        required: ['node'],
        properties: {
          node: true,
          format: {
            enum: codecList,
          },
        },
      },
    })
  }

  /**
   * @override Override of `Executor.decode`.
   */
  public async decode(source: string, format?: string): Promise<schema.Node> {
    return decode(vfile.create(source), source, { format })
  }

  /**
   * @override Override of `Executor.encode`.
   *
   * Return the encoded content as a `string`.
   * The string be base64 encoded if the codec returns a  `Vfile` who's
   * content is a `Buffer` (e.g. `rpng`).
   * `VFile`s with string content (e.g. `md`, `html`) are NOT base64 encoded.
   * Clients will need to deal with the two alternatives.
   */
  public async encode(
    node: schema.Node,
    dest?: string,
    format?: string
  ): Promise<string> {
    const encoding = await encode(node, {
      ...commonEncodeDefaults,
      format,
      filePath: dest,
    })
    if (dest !== undefined) {
      await vfile.write(encoding, dest)
      return dest
    } else {
      return encoding.toString('base64')
    }
  }
}

// istanbul ignore next
if (require.main === module)
  cli.main(new Encoda()).catch((error) => log.error(error))
