// homebridge-hue/lib/HueClient.js
//
// Homebridge plug-in for Philips Hue.
// Copyright © 2018-2025 Erik Baauw. All rights reserved.

import { once } from 'node:events'
import { hostname } from 'node:os'

import { timeout } from 'hb-lib-tools'
import { HttpClient } from 'hb-lib-tools/HttpClient'
import { OptionParser } from 'hb-lib-tools/OptionParser'

const hueMacPrefixes = ['001788', 'ECB5FA', 'C42996']

const apiV1Resources = [
  'capabilities',
  'config',
  'info',
  'lights',
  'groups',
  'schedules',
  'scenes',
  'sensors',
  'rules',
  'resourcelinks'
]

// API errors that could still cause (part of) the PUT command to be executed.
const nonCriticalApiErrorTypes = [
  6, // parameter not available
  7, // invalid value for parameter
  8, // paramater not modifiable
  201 // paramater not modifiable, device is set to off
]

// Estmate the number of Zigbee messages resulting from PUTting body.
function numberOfZigbeeMessages (body = {}) {
  let n = 0
  if (Object.keys(body).includes('on')) {
    n++
  }
  if (
    Object.keys(body).includes('bri') ||
    Object.keys(body).includes('bri_inc')
  ) {
    n++
  }
  if (
    Object.keys(body).includes('xy') ||
    Object.keys(body).includes('ct') ||
    Object.keys(body).includes('hue') ||
    Object.keys(body).includes('sat') ||
    Object.keys(body).includes('effect')
  ) {
    n++
  }
  return n === 0 ? 1 : n
}

/** Hue API error.
  * @hideconstructor
  * @extends HttpClient.HttpError
  * @memberof HueClient
  */
class HueError extends HttpClient.HttpError {
  /** The API error type.
    * @type {?integer}
    * @readonly
    */
  get type () {}

  /** The API error description.
    * @type {?string}
    * @readonly
    */
  get description () {}

  /** The API error is non-critical.
    * Part of the PUT command might still be executed.
    * @type {?boolean}
    * @readonly
    */
  get nonCritical () {}
}

/** Hue API response.
  * @hideconstructor
  * @extends HttpClient.HttpResponse
  * @memberof HueClient
  */
class HueResponse extends HttpClient.HttpResponse {
  /** An object containing the `"success"` API responses.
    * @type {object}
    * @readonly
    */
  get success () {}

  /** A list of `"error"` API responses.
    * @type {object[]}
    * @readonly
    */
  get errors () {}
}

/** REST API client for Hue bridge with API v1 and compatible servers.
  *
  * See the [Hue API v1](https://developers.meethue.com/develop/hue-api/)
  * documentation for a better understanding of the API.
  * @extends HttpClient
  */
class HueClient extends HttpClient {
  static get HueError () { return HueError }
  static get HueResponse () { return HueResponse }

  /** Check for Hue bridge.
    * @param {object} config - The bridge public configuration,
    * @returns {boolean}
    */
  static isHueBridge (config) {
    return /BSB00[1-3]/.test(config.modelid) &&
      hueMacPrefixes.includes(config.bridgeid.slice(0, 6))
  }

  /** Check if Hue bridge supports the Hue API v2.
    * @param {object} config - The bridge public configuration,
    * @returns {boolean}
    */
  static isHue2Bridge (config) {
    return HueClient.isHueBridge(config) &&
      BigInt(config.swversion) >= 1948086000n
  }

  /** SSL certificate of Hue bridge root CA, see
    * [Using HTTPS](https://developers.meethue.com/develop/application-design-guidance/using-https/).
    * @type {string}
    */
  static get rootCertificates () {
    return [
      `-----BEGIN CERTIFICATE-----
MIICMjCCAdigAwIBAgIUO7FSLbaxikuXAljzVaurLXWmFw4wCgYIKoZIzj0EAwIw
OTELMAkGA1UEBhMCTkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRQwEgYDVQQDDAty
b290LWJyaWRnZTAiGA8yMDE3MDEwMTAwMDAwMFoYDzIwMzgwMTE5MDMxNDA3WjA5
MQswCQYDVQQGEwJOTDEUMBIGA1UECgwLUGhpbGlwcyBIdWUxFDASBgNVBAMMC3Jv
b3QtYnJpZGdlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjNw2tx2AplOf9x86
aTdvEcL1FU65QDxziKvBpW9XXSIcibAeQiKxegpq8Exbr9v6LBnYbna2VcaK0G22
jOKkTqOBuTCBtjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNV
HQ4EFgQUZ2ONTFrDT6o8ItRnKfqWKnHFGmQwdAYDVR0jBG0wa4AUZ2ONTFrDT6o8
ItRnKfqWKnHFGmShPaQ7MDkxCzAJBgNVBAYTAk5MMRQwEgYDVQQKDAtQaGlsaXBz
IEh1ZTEUMBIGA1UEAwwLcm9vdC1icmlkZ2WCFDuxUi22sYpLlwJY81Wrqy11phcO
MAoGCCqGSM49BAMCA0gAMEUCIEBYYEOsa07TH7E5MJnGw557lVkORgit2Rm1h3B2
sFgDAiEA1Fj/C3AN5psFMjo0//mrQebo0eKd3aWRx+pQY08mk48=
-----END CERTIFICATE-----`,
      `-----BEGIN CERTIFICATE-----
MIIBzDCCAXOgAwIBAgICEAAwCgYIKoZIzj0EAwIwPDELMAkGA1UEBhMCTkwxFDAS
BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTAgFw0y
NTAyMjUwMDAwMDBaGA8yMDUwMTIzMTIzNTk1OVowPDELMAkGA1UEBhMCTkwxFDAS
BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABFfOO0jfSAUXGQ9kjEDzyBrcMQ3ItyA5krE+
cyvb1Y3xFti7KlAad8UOnAx0FBLn7HZrlmIwm1QnX0fK3LPM13mjYzBhMB0GA1Ud
DgQWBBTF1pSpsCASX/z0VHLigxU2CAaqoTAfBgNVHSMEGDAWgBTF1pSpsCASX/z0
VHLigxU2CAaqoTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggq
hkjOPQQDAgNHADBEAiAk7duT+IHbOGO4UUuGLAEpyYejGZK9Z7V9oSfnvuQ5BQIg
IYSgwwxHXm73/JgcU9lAM6c8Bmu3UE3kBIUwBs1qXFw=
-----END CERTIFICATE-----`
    ]
  }

  /** Create a new instance of a HueClient.
    *
    * The caller is expected to verify that the given host is a reachable Hue
    * bridge, by calling
    * {@link HueDiscovery#config HueDiscovery#config()} and passing the
    * response as `params.config`.<br>
    * The caller is expected to persist the API key,
    * passing it as `params.apiKey`.
    * If no API key is known {@link HueClient#getApiKey getApiKey()} can
    * be called to create one.<br>
    // * The client is expected to persist the fingerprint of the self-signed SSL
    // * certificate of gen-2 Hue bridge, passing it as `params.fingerprint`.
    // * If no `fingerprint` is known, it will be pinned on the first request to
    // * the Hue bridge, typically the call to
    // * {@link HueClient#getApiKey getApiKey()}.
    // * It can be obtained through the {@link HueClient#fingerprint fingerprint}
    // * property.
    *
    * @param {object} params - Parameters.
    * @param {?string} params.apiKey - The API key of the Hue bridge.
    * @param {object} params.config - The bridge public configuration,
    * i.e. the response of {@link HueDiscovery#config HueDiscovery#config()}.
    // * @param {?string} params.fingerprint - The fingerprint of the pinned
    // * self-signed SSL certificate of the Hue bridge
    // * with firmware v1.24.0 or greater.
    * @param {boolean} [params.forceHttp=false] - Force HTTP instead of HTTPS
    * for Hue bridge with firmware v1.24.0 and greater.
    * @param {!string} params.host - Hostname/IP address of the Hue bridge.
    * @param {boolean} [params.keepAlive=false] - Keep server connection(s)
    * open.
    * @param {integer} [params.maxSockets=20] - Throttle requests to maximum
    * number of parallel connections.
    * @param {integer} [params.timeout=5] - Request timeout (in seconds).
    * @param {integer} [params.waitTimePut=50] - The time (in milliseconds),
    * after sending a PUT request, to wait before sending another PUT request.
    * @param {integer} [params.waitTimePutGroup=1000] - The time (in
    * milliseconds), after sending a PUT request, to wait before sending
    * another PUT request.
    * @param {integer} [params.waitTimeResend=300] - The time, in milliseconds,
    * to wait before resending a request after an ECONNRESET, an http status
    * 503, or an api 901 error.
    */
  constructor (params = {}) {
    const _options = {
      keepAlive: false,
      maxSockets: 20,
      path: '/api',
      timeout: 5,
      waitTimePut: 50,
      waitTimePutGroup: 1000,
      waitTimeResend: 300
    }
    const optionParser = new OptionParser(_options)
    optionParser
      .stringKey('apiKey', true)
      .objectKey('config', true)
      // .stringKey('fingerprint', true)
      .boolKey('forceHttp')
      .hostKey('host')
      .boolKey('keepAlive')
      .intKey('maxSockets', 1, 20)
      .intKey('timeout', 1, 60)
      .intKey('waitTimePut', 0, 50)
      .intKey('waitTimePutGroup', 0, 1000)
      .intKey('waitTimeResend', 0, 1000)
      .parse(params)
    // if (_options.fingerprint != null) {
    //   _options.https = true
    // }
    _options.isHue = false
    if (HueClient.isHueBridge(_options.config)) {
      _options.isHue = true
      if (BigInt(_options.config.swversion) >= 1804201116n) {
        _options.https = true
      }
      if (BigInt(_options.config.swversion) >= 1948086000n) {
        _options.isHue2 = true
      }
    }
    if (_options.apiKey) {
      _options.path += '/' + _options.apiKey
      _options.headers = { 'hue-application-key': _options.apiKey }
    }

    const options = {
      host: _options.hostname,
      json: true,
      keepAlive: _options.keepAlive,
      maxSockets: _options.maxSockets,
      timeout: _options.timeout
    }
    if (_options.https && !_options.forceHttp) {
      options.https = true
      // options.selfSignedCertificate = true
      options.ca = HueClient.rootCertificates
      options.checkServerIdentity = (hostname, cert) => {
        return this.checkServerIdentity(hostname, cert)
      }
    }
    super(options)
    this._options = _options
    this.waitForIt = false
    this.setMaxListeners(30)
  }

  /** The ID (mac address) of the Hue bridge.
    * @type {string}
    * @readonly
    */
  get bridgeId () { return this._options.config.bridgeid }

  // /** The fingerprint of the self-signed SSL certificate of the Hue bridge with
  //   * firmware v1.24.0 or greater.
  //   *
  //   * @type {string}
  //   */
  // get fingerprint () { return this._options.fingerprint }
  // set fingerprint (value) { this._options.fingerprint = value }

  /** True when connected to a Hue bridge.
    * @type {boolean}
    * @readonly
    */
  get isHue () { return this._options.isHue }

  /** True when connected to a Hue bridge with API v2.
    * @type {boolean}
    * @readonly
    */
  get isHue2 () { return this._options.isHue2 }

  /** The API key.
    * @type {string}
    */
  get apiKey () { return this._options.apiKey }
  set apiKey (value) {
    this._options.apiKey = value
    this._options.headers = { 'hue-application-key': value }
    this._options.path = '/api'
    if (value != null) {
      this._options.path += '/' + value
    }
  }

  // ===========================================================================

  /** Issue a GET request of `/api/`_apiKey_`/`_resource_ (API v1) or of
    * `/clip/v2/resource/`_resource_ (API v2).
    *
    * @param {string} resource - The resource.<br>
    * This might be a resource as exposed by the API, e.g. `/lights/1/state`,
    * or an attribute returned by the API, e.g. `/lights/1/state/on`.
    * @return {*} response - The JSON response body converted to JavaScript.
    * @throws {HueError} In case of error.
    */
  async get (resource) {
    if (typeof resource !== 'string' || resource[0] !== '/') {
      throw new TypeError(`${resource}: invalid resource`)
    }
    let request = this.request.bind(this)
    this.path = this._options.path
    let path = resource.slice(1).split('/')
    switch (path[0]) {
      case '':
      case 'capabilities':
      case 'config':
        if (path.length > 1) {
          resource = '/' + path.shift()
          break
        }
        path = []
        break
      case 'info':
      case 'lights':
      case 'groups':
      case 'schedules':
      case 'scenes':
      case 'sensors':
      case 'rules':
      case 'resourcelinks':
        if (path.length > 2) {
          resource = '/' + path.shift() + '/' + path.shift()
          break
        }
        path = []
        break
      case 'resource':
        resource = '/'
        // fall through
      default:
        this.path = '/clip/v2/resource'
        request = this.request2.bind(this)
        if (path.length >= 2) {
          resource = '/' + path.shift() + '/' + path.shift()
          path.unshift('0') // dereference array of only 1 element
          break
        }
        path = []
        break
    }
    let { body } = await request('GET', resource)
    for (const key of path) {
      if (typeof body === 'object' && body != null) {
        body = body[key]
      }
    }
    if (body == null && path.length > 0) {
      throw new Error(
        `/${path.join('/')}: not found in resource ${resource}`
      )
    }
    return body
  }

  /** Issue a PUT request to `/api/`_apiKey_`/`_resource_.
    *
    * HueClient throttles the number of PUT requests to limit the Zigbee traffic
    * to 20 unicast messsages per seconds, or 1 broadcast message per second,
    * delaying the request when needed.
    * @param {string} resource - The resource.
    * @param {*} body - The body, which will be converted to JSON.
    * @return {HueResponse} response - The response.
    * @throws {HueError} In case of error, except for non-critical API errors.
    */
  async put (resource, body) {
    if (this.waitForIt) {
      while (this.waitForIt) {
        try {
          await once(this, '_go')
        } catch (error) {}
      }
    }
    const timeout = numberOfZigbeeMessages(body) * (
      resource.startsWith('/groups')
        ? this._options.waitTimePutGroup
        : this._options.waitTimePut
    )
    if (timeout > 0) {
      this.waitForIt = true
      setTimeout(() => {
        this.waitForIt = false
        this.emit('_go')
      }, timeout)
    }
    if (apiV1Resources.includes(resource.slice(1).split('/')[0])) {
      this.path = this._options.path
      return this.request('PUT', resource, body)
    } else {
      this.path = '/clip/v2/resource'
      return this.request2('PUT', resource, body)
    }
  }

  /** Issue a POST request to `/api/`_apiKey_`/`_resource_.
    *
    * @param {string} resource - The resource.
    * @param {*} body - The body, which will be converted to JSON.
    * @return {HueResponse} response - The response.
    * @throws {HueError} In case of error.
    */
  async post (resource, body) {
    if (apiV1Resources.includes(resource.slice(1).split('/')[0])) {
      this.path = this._options.path
      return this.request('POST', resource, body)
    } else {
      this.path = '/clip/v2/resource'
      return this.request2('POST', resource, body)
    }
  }

  /** Issue a DELETE request of `/api/`_apiKey_`/`_resource_.
    * @param {string} resource - The resource.
    * @param {*} body - The body, which will be converted to JSON.
    * @return {HueResponse} response - The response.
    * @throws {HueError} In case of error.
    */
  async delete (resource, body) {
    if (apiV1Resources.includes(resource.slice(1).split('/')[0])) {
      this.path = this._options.path
      return this.request('DELETE', resource, body)
    } else {
      this.path = '/clip/v2/resource'
      return this.request2('DELETE', resource, body)
    }
  }

  // ===========================================================================

  /** Create an API key and set {@link HueClient#apiKey apiKey}.
    *
    * Calls {@link HueClient#post post()} to issue a POST request to `/api`.
    *
    * Before calling `getApiKey`, the link button on the Hue bridge must be
    * pressed.
    * @return {string} apiKey - The newly created API key.
    * @throws {HueError} In case of error.
    */
  async getApiKey (application) {
    if (typeof application !== 'string' || application === '') {
      throw new TypeError(`${application}: invalid application name`)
    }
    const apiKey = this._options.apiKey
    const body = { devicetype: `${application}#${hostname().split('.')[0]}` }
    this.apiKey = null
    try {
      this.path = '/api'
      const response = await this.request('POST', '/', body)
      this.apiKey = response.success.username
      return this.apiKey
    } catch (error) {
      this.apiKey = apiKey
      throw (error)
    }
  }

  /** Return the Hue API v2 application key.
    *
    * @return {string} apiKey - The newly created API key.
    * @throws {HueError} In case of error.
    */
  async getApplicationKey () {
    this.path = '/'
    const { headers } = await this.request2('GET', '/auth/v1')
    return headers['hue-application-id']
  }

  /** Unlock the bridge to allow creating a new API key.
    *
    * Calls {@link HueClient#put put()} to issue a PUT request to
    * `/api/`_apiKey_`/config`.
    * This is the API equivalent of pressing the link button on the Hue bridge.
    *
    * Note that as of firmware v1.31.0, the gen-2 Hue bridge no longer allows
    * unlocking the bridge through the API.
    * @return {HueResponse} response - The response.
    * @throws {HueError} In case of error.
    */
  async unlock () {
    return this.put('/config', { linkbutton: true })
  }

  /** Initiate a touchlink pairing.
    *
    * Calls {@link HueClient#put put()} to issue
    * a PUT request to `/api/`_apiKey_`/config` to initiate touchlink pairing.
    * This is the API equivalent of holding the link button on the Hue bridge.
    *
    * @return {HueResponse} response - The response.
    * @throws {HueError} In case of error.
    */
  async touchlink () {
    return this.put('/config', { touchlink: true })
  }

  /** Search for new devices.
    *
    * Calls {@link HueClient#post post()} to issue a POST request to
    * `/api/`_apiKey_`/lights`, to enable pairing of new Zigbee devices.
    *
    * To see the newly paired devices, issue a GET request of
    * `/api/`_apiKey_`/lights/new` and/or `/api/`_apiKey_`/sensor/new`
    * @return {HueResponse} response - The response.
    * @throws {HueError} In case of error.
    */
  async search () {
    return this.post('/lights')
  }

  /** Restart the bridge.
    * Calls {@link HueClient#put put()} to issue a PUT request to
    * `/api/`_apiKey_`/config`, to reboot the Hue bridge.
    *
    * @return {HueResponse} response - The response.
    * @throws {HueError} In case of error.
    */
  async restart () {
    return this.put('/config', { reboot: true })
  }

  // ===========================================================================

  /** Check Hue bridge server identity
    * @params {string} hostname - The hostname of the Hue bridge.
    * @params {object} cert - The SSL certificate of the Hue bridge.
    * @returns {Error} For invalid SSL certificate.
    */
  checkServerIdentity (hostname, cert) {
    if (Object.keys(cert).length > 0) {
      // if (this._options.fingerprint != null) {
      //   if (cert.fingerprint256 !== this._options.fingerprint) {
      //     return new Error('SSL certificate fingerprint mismatch')
      //   }
      //   return
      // }
      if (
        cert.subject == null ||
        cert.subject.C !== 'NL' ||
        cert.subject.O !== 'Philips Hue' ||
        cert.subject.CN.toUpperCase() !== this.bridgeId ||
        ('00' + cert.serialNumber).slice(-16) !== this.bridgeId
      ) {
        return new Error('invalid SSL certificate')
      }
      if (
        cert.issuer == null ||
        cert.issuer.C !== 'NL' ||
        cert.issuer.O !== 'Philips Hue' || (
          cert.issuer.CN.toUpperCase() !== this.bridgeId &&
          cert.issuer.CN !== 'root-bridge'
        )
      ) {
        return new Error('invalid issuer certificate')
      }
      // Pin certificate.
      // this._options.fingerprint = cert.fingerprint256
    }
  }

  /** Issue an API v1 HTTP(S) request to the Hue bridge.
    *
    * This method does the heavy lifting for {@link HueClient#get get()},
    * {@link HueClient#put put()}, {@link HueClient#post post()}, and
    * {@link HueClient#delete delete()}.
    * It shouldn't be called directly.
    *
    * @param {string} method - The method for the request.
    * @param {!string} resource - The resource for the request.
    * @param {?*} body - The body for the request.
    * @return {HueResponse} response - The response.
    * @throws {HueError} In case of error.
    */
  async request (method, resource, body = null, retry = 0) {
    try {
      const response = await super.request(method, resource, body)
      if (response.headers['content-length'] === '0') {
        response.body = null
      }
      response.errors = []
      response.success = {}
      if (Array.isArray(response.body)) {
        for (const id in response.body) {
          const e = response.body[id].error
          if (e != null && typeof e === 'object') {
            response.errors.push({ type: e.type, description: e.description })
            const error = new Error(`${e.address}: api error ${e.type}: ${e.description}`)
            error.request = response.request
            error.type = e.type
            error.description = e.description
            error.nonCritical = nonCriticalApiErrorTypes.includes(error.type)
            /** Emitted for each API error returned by the Hue bridge.
              *
              * @event HueClient#error
              * @param {HueError} error - The error.
              */
            this.emit('error', error)
            if (!error.nonCritical) {
              throw error
            }
          }
          const s = response.body[id].success
          if (s != null && typeof s === 'object') {
            for (const path of Object.keys(s)) {
              const a = path.split('/')
              const key = a[a.length - 1]
              response.success[key] = s[path]
            }
          }
        }
      }
      return response
    } catch (error) {
      if (
        error.code === 'ECONNRESET' ||
        error.statusCode === 503 ||
        error.type === 901
      ) {
        if (error.request != null && this._options.waitTimeResend > 0 && retry < 5) {
          error.message += ' - retry in ' + this._options.waitTimeResend + 'ms'
          this.emit('error', error)
          await timeout(this._options.waitTimeResend)
          return this.request(method, resource, body, retry + 1)
        }
      }
      throw error
    }
  }

  /** Issue an API v2 HTTPS request to the Hue bridge.
    *
    * This method does the heavy lifting for {@link HueClient#get get()},
    * {@link HueClient#put put()}, {@link HueClient#post post()}, and
    * {@link HueClient#delete delete()}.
    * It shouldn't be called directly.
    *
    * @param {string} method - The method for the request.
    * @param {!string} resource - The resource for the request.
    * @param {?*} body - The body for the request.
    * @return {HueResponse} response - The response.
    * @throws {HueError} In case of error.
    */
  async request2 (method, resource, body = null, retry = 0) {
    try {
      const response = await super.request(
        method, resource, body, this._options.headers
      )
      for (const e of response.body?.errors ?? []) {
        const error = new Error(`api error ${e}`)
        this.emit('error', error)
      }
      response.body = response.body.data
      return response
    } catch (error) {
      if (
        error.code === 'ECONNRESET' ||
        error.statusCode === 503 ||
        error.type === 901
      ) {
        if (error.request != null && this._options.waitTimeResend > 0 && retry < 5) {
          error.message += ' - retry in ' + this._options.waitTimeResend + 'ms'
          this.emit('error', error)
          await timeout(this._options.waitTimeResend)
          return this.request(method, resource, body, retry + 1)
        }
      }
      throw error
    }
  }
}

export { HueClient }
