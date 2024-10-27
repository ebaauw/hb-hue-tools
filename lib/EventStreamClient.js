// homebridge-hue/lib/EventStreamClient.js
//
// Homebridge plug-in for Philips Hue.
// Copyright © 2021-2024 Erik Baauw. All rights reserved.

import { EventEmitter } from 'node:events'
import https from 'node:https'

import { timeout } from 'hb-lib-tools'
import { OptionParser } from 'hb-lib-tools/OptionParser'

import { HueClient } from './HueClient.js'
const { HttpError } = HueClient

/** Client for Hue API v2 event stream notifications.
  *
  * See the
  * [Hue API v2](https://developers.meethue.com/develop/hue-api-v2/migration-guide-to-the-new-hue-api/)
  * documentation for a better understanding of the event stream notifications.
  * @copyright © 2021 Erik Baauw. All rights reserved.
  */
class EventStreamClient extends EventEmitter {
  /** Create a new web socket client instance.
    * @param {object} params - Parameters.
    * @param {integer} [params.retryTime=10] - Time (in seconds) to try and
    * reconnect when the server connection has been closed.
    * @param {boolean} [params.raw=false] - Issue raw events instead of parsing
    * them.<br>
    * When specified, {@link EventStreamClient#event:notification notification}
    * events are emitted, in lieu of {@link EventStreamClient#event:changed changed}.
    * @param {int} [params.version=1] - Use API v1 vs API v2 style for
    * {@link EventStreamClient#event:changed changed} events.
    */
  constructor (client, params = {}) {
    super()
    if (!(client instanceof HueClient)) {
      throw new TypeError('client: not a HueClient')
    }
    this.options = {
      client,
      retryTime: 10,
      resource: '/eventstream/clip/v2',
      url: 'https://' + client.host,
      version: 1
    }
    const optionParser = new OptionParser(this.options)
    optionParser
      .boolKey('raw')
      .intKey('retryTime', 0, 120)
      .intKey('version', 1, 2)
      .parse(params)
    this.requestId = 0
  }

  /** Initialise the event stream client.
    */
  async init () {
    if (this.options.version === 1 && this.buttonMap == null) {
      // Get the API v2 button IDs
      const response = await this.options.client.get('/button')

      // Build a map to convert ID to buttonevent.
      this.buttonMap = {}
      for (const button of response) {
        this.buttonMap[button.id] = button.metadata.control_id * 1000
      }
      this.requestId = 1
    }
  }

  /** Listen for web socket notifications.
    */
  listen () {
    this.request = https.request(this.options.url + this.options.resource, {
      rejectUnauthorized: false,
      // ca: HueClient.rootCertificate,
      checkServerIdentity: (hostname, cert) => {
        return this.options.client.checkServerIdentity(hostname, cert)
      },
      family: 4,
      headers: {
        'hue-application-key': this.options.client.apiKey,
        Accept: 'text/event-stream'
      },
      method: 'GET',
      keepAlive: true
    })
    const requestInfo = {
      name: this.options.client.name,
      id: ++this.requestId,
      method: 'GET',
      resource: this.options.resource,
      url: this.options.url + this.options.resource
    }
    this.request
      .on('error', (error) => {
        if (!(error instanceof HttpError)) {
          error = new HttpError(error.message, requestInfo)
        }
        this.emit('error', error)
      })
      .on('socket', (socket) => {
        this.emit('request', requestInfo)
        socket
          .setKeepAlive(true)
          .on('close', async () => {
            try {
              await this.close(true)
            } catch (error) { this.emit('error', error) }
          })
      })
      .on('response', (response) => {
        this.emit('response', {
          statusCode: 200,
          statusMessage: 'OK',
          request: requestInfo
        })
        this.listening = true
        /** Emitted when the connection to the event stream has been opened.
          * @event EventStreamClient#listening
          * @param {string} url - The URL of the event stream.
          */
        this.emit('listening', this.options.url + this.options.resource)
        let s = ''
        response
          .on('data', (buffer) => {
            try {
              s += buffer.toString('utf-8')
              if (s.slice(-2) !== '\n\n') {
                return
              }
              s = s.trim()
              this.emit('data', s)
              const lines = s.split('\n')
              s = ''
              for (const line of lines) {
                const a = line.split(': ')
                if (a[0] === 'data') {
                  const container = JSON.parse(a[1])
                  if (this.options.raw) {
                    this.emit('notification', container)
                  } else {
                    this._parseContainer(container)
                  }
                }
              }
            } catch (error) { this.emit('error', error) }
          })
      })
    this.request.end()
  }

  /** Close the event stream.
    */
  async close (retry = false) {
    if (this.request != null) {
      this.request.destroy()
      this.request.removeAllListeners()
      delete this.request
    }
    if (this.listening) {
      /** Emitted when the connection to the event stream has been closed.
        * @event EventStreamClient#closed
        * @param {string} url - The URL of the event stream.
        */
      this.emit('closed', this.options.url + this.options.resource)
      this.listening = false
    }
    if (retry && this.options.retryTime > 0) {
      await timeout(this.options.retryTime * 1000)
      this.listen()
    }
  }

  _parseContainer (container) {
    for (const obj of container) {
      switch (obj.type) {
        case 'update':
          this['_parseUpdate' + this.options.version](obj)
          break
        default:
          this.emit('notification', obj)
          break
      }
    }
  }

  _parseUpdate1 (obj) {
    for (const data of obj.data) {
      let emitted = false
      const resource = data.id_v1
      const attr = {}
      const state = {}
      const config = {}
      for (const key of Object.keys(data)) {
        const value = data[key]
        switch (key) {
          case 'on':
            state.on = value.on
            break
          case 'dimming':
            state.bri = Math.round(value.brightness * 2.54)
            break
          case 'color':
            state.xy = [value.xy.x, value.xy.y]
            break
          case 'color_temperature':
            if (value.mirek_valid) {
              state.ct = value.mirek
            }
            break
          case 'status':
            if (resource.startsWith('/sensors')) {
              config.reachable = value === 'connected'
            } else if (resource.startsWith('/scenes')) {
              attr.active = value.active
            } else {
              state.reachable = value === 'connected'
            }
            break
          case 'button':
            state.buttonevent = this.buttonMap[data.id] + {
              initial_press: 0,
              repeat: 1,
              short_release: 2,
              long_release: 3
            }[value.button_report.event]
            state.lastupdated = value.button_report.updated.slice(0, -1)
            break
          case 'relative_rotary':
            state.rotaryevent = value.rotary_report.action === 'start' ? 1 : 2
            state.expectedrotation = value.rotary_report.rotation.steps *
              (value.rotary_report.rotation.direction === 'clock_wise' ? 1 : -1)
            state.expectedeventduration = value.rotary_report.rotation.duration
            state.lastupdated = value.rotary_report.updated.slice(0, -1)
            break
          case 'motion':
            if (value.motion_valid) {
              state.presence = value.motion
              state.lastupdated = obj.creationtime.slice(0, -1)
            }
            break
          case 'light':
            if (value.light_level_valid) {
              state.lightlevel = value.light_level
              state.lastupdated = obj.creationtime.slice(0, -1)
            }
            break
          case 'temperature':
            if (value.temperature_valid) {
              state.temperature = Math.round(value.temperature * 100)
              state.lastupdated = obj.creationtime.slice(0, -1)
            }
            break
          case 'enabled':
            config.on = value
            break
          case 'metadata':
            attr.name = value.name
            break
          default:
            break
        }
      }
      if (resource != null) {
        if (Object.keys(attr).length > 0) {
          /** Emitted when an `update` notification has been received
            * for an API v1 resource.
            * @event EventStreamClient#changed
            * @param {string} resource - The changed resource.<br>
            * For API v1, this can be a `/lights`, `/groups`, or `/sensors`
            * resource for top-level attributes, or a `state` or
            * `config` sub-resource.
            * @param {object} attributes - The changed attributes.
            */
          this.emit('changed', resource, attr)
          emitted = true
        }
        if (Object.keys(state).length > 0) {
          this.emit('changed', resource + '/state', state)
          emitted = true
        }
        if (Object.keys(config).length > 0) {
          this.emit('changed', resource + '/config', config)
          emitted = true
        }
      }
      if (!emitted) {
        /** Emitted when an unknown notification has been received, or when
          * `params.raw` was specified to the
          * {@link EventStreamClient constructor}.
          * @event EventStreamClient#notification
          * @param {object} notification - The raw notification.
          */
        this.emit('notification', obj)
      }
    }
  }

  _parseUpdate2 (obj) {
    for (const data of obj.data) {
      const resource = ['', data.type, data.id].join('/')
      const attr = {}
      for (const key of Object.keys(data)) {
        const value = data[key]
        if (!['id', 'id_v1', 'owner', 'type'].includes(key)) {
          attr[key] = value
        }
      }
      if (resource != null) {
        if (Object.keys(attr).length > 0) {
          /** Emitted when an `update` notification has been received
            * for an API v2 resource.
            * @event EventStreamClient#changed2
            * @param {string} resource - The changed API v2 resource.
            * @param {object} attributes - The attributes.
            */
          this.emit('changed', resource, attr)
        } else {
          this.emit('notification', obj)
        }
      }
    }
  }
}

export { EventStreamClient }
