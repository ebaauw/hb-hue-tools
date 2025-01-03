// homebridge-hue/lib/HueDiscovery.js
//
// Homebridge plug-in for Philips Hue.
// Copyright © 2018-2025 Erik Baauw. All rights reserved.

import { EventEmitter, once } from 'node:events'

import { timeout } from 'hb-lib-tools'
import { Bonjour } from 'hb-lib-tools/Bonjour'
import { HttpClient } from 'hb-lib-tools/HttpClient'
import { OptionParser } from 'hb-lib-tools/OptionParser'
import { UpnpClient } from 'hb-lib-tools/UpnpClient'

import { parseStringPromise } from 'xml2js'

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
      .intKey('timeout', 1, 60)
      .parse(params)
  }

  /** Issue an unauthenticated GET request of `/api/config` to given host.
    *
    * @param {string} host - The IP address or hostname of the Hue bridge.
    * @return {object} response - The JSON response body converted to JavaScript.
    * @throws {HttpError} In case of error.
    */
  async config (host) {
    const { hostname } = OptionParser.toHost('host', host)
    const client = new HttpClient({
      host: hostname,
      json: true,
      path: '/api',
      timeout: this._options.timeout
    })
    client
      .on('error', (error) => {
        /** Emitted when an error has occured.
          *
          * @event HueDiscovery#error
          * @param {HttpError} error - The error.
          */
        this.emit('error', error)
      })
      .on('request', (request) => {
        /** Emitted when request has been sent.
          *
          * @event HueDiscovery#request
          * @param {HttpRequest} request - The request.
          */
        this.emit('request', request)
      })
      .on('response', (response) => {
        /** Emitted when a valid response has been received.
          *
          * @event HueDiscovery#response
          * @param {HttpResponse} response - The response.
          */
        this.emit('response', response)
      })
    const { body, request } = await client.get('/config')
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
    *
    * @param {string} host - The IP address or hostname of the Hue bridge.
    * @return {object} response - The description, converted to JavaScript.
    * @throws {Error} In case of error.
    */
  async description (host) {
    const { hostname } = OptionParser.toHost('host', host)
    const options = {
      host: hostname,
      timeout: this._options.timeout
    }
    const client = new HttpClient(options)
    client
      .on('error', (error) => { this.emit('error', error) })
      .on('request', (request) => { this.emit('request', request) })
      .on('response', (response) => { this.emit('response', response) })
    const { body } = await client.get('/description.xml')
    const xmlOptions = { explicitArray: false }
    const result = await parseStringPromise(body, xmlOptions)
    return result
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
    this.jobs.push(this._mdns())
    this.jobs.push(this._upnp())
    if (!options.stealth) {
      this.jobs.push(this._nupnp({
        name: 'meethue.com',
        https: !this._options.forceHttp,
        host: 'discovery.meethue.com'
      }))
    }
    for (const job of this.jobs) {
      await job
    }
    return this.bridgeMap
  }

  _found (name, id, host) {
    /** Emitted when a potential bridge has been found.
      * @event HueDiscovery#found
      * @param {string} name - The name of the search method.
      * @param {string} bridgeid - The ID of the bridge.
      * @param {string} host - The IP address/hostname of the bridge.
      */
    this.emit('found', name, id, host)
    if (this.bridgeMap[host] == null) {
      this.bridgeMap[host] = id
      this.jobs.push(
        this.config(host).then((config) => {
          this.bridgeMap[host] = config
        }).catch((error) => {
          delete this.bridgeMap[host]
          if (error.request == null) {
            this.emit('error', error)
          }
        })
      )
    }
  }

  async _mdns () {
    const bonjour4 = new Bonjour()
    this.emit('searching', 'mdns', '224.0.0.251:5353')
    const browser4 = bonjour4.find({ type: 'hue' })
    browser4.on('up', (obj) => {
      this._found('mdns', obj.txt.bridgeid.toUpperCase(), obj.referer.address)
    })
    await timeout(this._options.timeout * 1000)
    this.emit('searchDone', 'mdns')
    bonjour4.destroy()
  }

  async _upnp () {
    const upnpClient = new UpnpClient({
      filter: (message) => {
        return /^(001788|ECB5FA)[0-9A-F]{10}$/.test(message['hue-bridgeid'])
      },
      timeout: this._options.timeout
    })
    upnpClient
      .on('error', (error) => { this.emit('error', error) })
      .on('searching', (host) => {
        /** Emitted when UPnP search has started.
          *
          * @event HueDiscovery#searching
          * @param {string} name - The name of the search method: mdns or upnp.
          * @param {string} host - The IP address and port from which the
          * search was started.
          */
        this.emit('searching', 'upnp', host)
      })
      .on('request', (request) => {
        request.name = 'upnp'
        this.emit('request', request)
      })
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
          this._found('upnp', obj['hue-bridgeid'], host)
        }
      })
    upnpClient.search()
    await once(upnpClient, 'searchDone')
    /** Emitted when UPnP search has concluded.
      *
      * @event HueDiscovery#searchDone
      * @param {string} name - The name of the search method: mdns or upnp.
      */
    this.emit('searchDone', 'upnp')
  }

  async _nupnp (options) {
    options.json = true
    options.timeout = this._options.timeout
    const client = new HttpClient(options)
    client
      .on('error', (error) => { this.emit('error', error) })
      .on('request', (request) => { this.emit('request', request) })
      .on('response', (response) => { this.emit('response', response) })
    try {
      const { body } = await client.get()
      if (Array.isArray(body)) {
        for (const bridge of body) {
          let host = bridge.internalipaddress
          if (bridge.internalport != null && bridge.internalport !== 80) {
            host += ':' + bridge.internalport
          }
          this._found(options.name, bridge.id.toUpperCase(), host)
        }
      }
    } catch (error) {
      if (error instanceof HttpClient.HttpError) {
        return
      }
      this.emit('error', error)
    }
  }
}

export { HueDiscovery }
