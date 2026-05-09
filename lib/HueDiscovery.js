// homebridge-hue/lib/HueDiscovery.js
//
// Homebridge plug-in for Philips Hue.
// Copyright © 2018-2026 Erik Baauw. All rights reserved.

import { EventEmitter } from 'node:events'

import { HttpClient } from 'hb-lib-tools/HttpClient'
import { OptionParser } from 'hb-lib-tools/OptionParser'

/** Class for discovery of Hue bridges.
  *
  * See the [Hue API](https://developers.meethue.com/develop/get-started-2/)
  * documentation for a better understanding of the API.
  * @extends EventEmitter
  */
class HueDiscovery extends EventEmitter {
  /** Create a new instance.
    * @param {object} params - Parameters.
    * @param {boolean} [params.forceHttp=false] - Use plain HTTP instead of HTTPS.
    * @param {?*} params.logger - Logger to use for logging.  If null, no logging is done.
    * @param {integer} [params.timeout=5] - Timeout (in seconds) for requests.
    */
  constructor (params = {}) {
    super()
    this._options = {
      forceHttp: false,
      timeout: 5
    }
    const optionParser = new OptionParser(this._options)
    optionParser
      .boolKey('forceHttp')
      .instanceKey('logger')
      .intKey('timeout', 1, 60)
      .parse(params)
    for (const f of ['warn', 'log', 'debug', 'vdebug', 'vvdebug']) {
      this[f] = this._options.logger?.[f]?.bind(this._options.logger) ?? (() => {})
    }
  }

  /** Issue an unauthenticated GET request of `/api/config` to given host.
    *
    * @param {string} host - The IP address or hostname and port of the Hue bridge.
    * @return {object} response - The JSON response body converted to JavaScript.
    * @throws {HttpError} In case of error.
    */
  async config (host) {
    const { hostname, port } = OptionParser.toHost('host', host)
    const https = port === 443
    const client = new HttpClient({
      host: hostname,
      https,
      json: true,
      name: host + ' config',
      logger: this._options.logger,
      path: '/api',
      selfSignedCertificate: https,
      timeout: this._options.timeout,
      validStatusCodes: https ? [200] : [200, 301]
    })
    const { body, request, statusCode } = await client.get('/config')
    if (statusCode === 301) {
      return this.config(hostname + ':443')
    }
    if (
      body == null || typeof body !== 'object' ||
      typeof body.apiversion !== 'string' ||
      !/[0-9A-Fa-f]{16}/.test(body.bridgeid) ||
      typeof body.name !== 'string' ||
      typeof body.swversion !== 'string'
    ) {
      const error = new Error('invalid response')
      error.request = request
      this.emit('error', error)
      throw error
    }
    if (/^00212E[0-9A-F]{10}$/.test(body.bridgeid)) {
      const error = new Error(`${host}: deCONZ gateway no longer supported`)
      error.request = request
      this.emit('error', error)
      throw error
    }
    return body
  }

  /** Issue an unauthenticated GET request of `/description.xml` to given host.
    * Note that the Hue Bridge Pro no longer seems to provide this endpoint.
    *
    * @param {string} host - The IP address or hostname and port of the Hue bridge.
    * @return {object} response - The description, converted to JavaScript.
    * @throws {Error} In case of error.
    */
  async description (host) {
    if (this.xmlParser == null) {
      const Parser = await import('xml2js')
      this.xmlParser = new Parser({ explicitArray: false })
    }
    const { hostname, port } = OptionParser.toHost('host', host)
    const https = port === 443
    const options = {
      host: hostname,
      https,
      logger: this._options.logger,
      name: host + ' description',
      selfSignedCertificate: https,
      timeout: this._options.timeout,
      validStatusCodes: https ? [200] : [200, 301],
      xmlParser: async (xml) => { return this.xmlParser.parseStringPromise(xml) }
    }
    const client = new HttpClient(options)
    const { body, statusCode } = await client.get('/description.xml')
    if (statusCode === 301) {
      return this.description(hostname + ':443')
    }
    return body
  }

  /** Discover Hue bridges.
    *
    * Queries the MeetHue portal for known bridges and does a local search over
    * mDNS (Bonjour) and UPnP.
    * Calls {@link HueDiscovery#config config()} for each discovered bridge
    * for verification.
    * @param {object} params - Parameters.
    * @param {boolean} [params.stealth=false] - Don't query discovery portals.
    * @return {object} response - Response object with a key/value pair per
    * found bridge.  The key is the host (IP address or hostname), the value is
    * the return value of {@link HueDiscovery#config config()}.
    */
  async discover (params = {}) {
    const options = {
      stealth: false
    }
    const optionParser = new OptionParser(options)
    optionParser
      .boolKey('stealth')
      .parse(params)

    this.bridgeMap = {}
    this.jobs = []
    this.jobs.push(this.#mdns())
    this.jobs.push(this.#upnp())
    if (!options.stealth) {
      this.jobs.push(this.#nupnp())
    }
    for (const job of this.jobs) {
      await job
    }
    return this.bridgeMap
  }

  #found (name, id, host) {
    this.debug('%s: found %s at %s', name, id, host)
    /** Emitted when a potential bridge has been found.
      * @event HueDiscovery#found
      * @param {string} name - The name of the search method.
      * @param {string} bridgeid - The ID of the bridge.
      * @param {string} host - The IP address/hostname of the bridge.
      */
    this.emit('found', name, id, host)
    const { hostname } = OptionParser.toHost('host', host)
    if (this.bridgeMap[hostname] == null) {
      this.bridgeMap[hostname] = id
      this.jobs.push(
        this.config(host).then((config) => {
          this.bridgeMap[hostname] = config
        }).catch((error) => {
          delete this.bridgeMap[hostname]
          if (error.request == null) {
            this.emit('error', error)
          }
        })
      )
    }
  }

  async #mdns () {
    if (this.mdnsClient == null) {
      const { MdnsClient } = await import('hb-lib-tools/MdnsClient')
      this.mdnsClient = new MdnsClient({
        logger: this._options.logger,
        serviceType: 'hue',
        timeout: this._options.timeout
      })
      this.mdnsClient
        .on('serviceUp', (address, message) => {
          this.#found('mdns', message.txt.bridgeid.toUpperCase(), address)
        })
    }
    await this.mdnsClient.search()
  }

  async #upnp () {
    if (this.upnpClient == null) {
      const { UpnpClient } = await import('hb-lib-tools/UpnpClient')
      this.upnpClient = new UpnpClient({
        filter: (message) => {
          return /^(001788|ECB5FA)[0-9A-F]{10}$/.test(message['hue-bridgeid'])
        },
        logger: this,
        timeout: this._options.timeout
      })
      this.upnpClient
        .on('deviceFound', (address, obj, message) => {
          let host
          const a = obj.location.split('/')
          if (a.length > 3 && a[2] != null) {
            host = a[2]
            const b = host.split(':')
            const port = parseInt(b[1])
            if (port === 80) {
              host = b[0]
            }
            this.#found('upnp', obj['hue-bridgeid'], host)
          }
        })
    }
    await this.upnpClient.search()
  }

  async #nupnp () {
    const name = 'meethue.com'
    if (this.client == null) {
      this.client = new HttpClient({
        host: 'discovery.meethue.com',
        https: !this._options.forceHttp,
        json: true,
        name,
        logger: this._options.logger,
        timeout: this._options.timeout
      })
    }
    try {
      const { body } = await this.client.get()
      if (Array.isArray(body)) {
        for (const bridge of body) {
          this.#found(
            name, bridge.id.toUpperCase(),
            bridge.internalipaddress + ':' + (bridge.port ?? 80)
          )
        }
      }
    } catch (error) {
      if (error instanceof HttpClient.HttpError) {
        return
      }
      this.warn(error)
    }
  }
}

export { HueDiscovery }
