// hb-deconz-tools/lib/HueResponse.js
//
// Homebridge plug-in for Philips Hue.
// Copyright © 2018-2025 Erik Baauw. All rights reserved.

import { HttpClient } from 'hb-lib-tools/HttpClient'

import { HueError } from 'hb-hue-tools/HueError'

/** Wrapper for Hue API API response.
  * <br>See {@link ApiResponse}.
  * @name ApiResponse
  * @type {Class}
  * @memberof module:hb-hue-tools
  */

/** Hue API error.
  * @extends HttpClient.HttpError
  */
class HueResponse extends HttpClient.HttpResponse {
  /** Create a new instance of HueApiResponse.
    * @param {HttpClient.HttpResponse} response - The HTTP response.
    */
  constructor (response) {
    super(
      response.request, response.statusCode, response.statusMessage,
      response.headers, response.body, response.parsedBody
    )

    /** @member {object} - An object with the `"success"` API responses.
      */
    this.success = {}

    /** @member {HueError[]} - A list of `"error"` API responses.
      */
    this.errors = []

    if (Array.isArray(response.body)) {
      // Hue API v1 response.
      for (const id in response.body) {
        const e = response.body[id].error
        if (e != null && typeof e === 'object') {
          this.errors.push(new HueError(e, response))
        }
        const s = response.body[id].success
        if (s != null && typeof s === 'object') {
          for (const path of Object.keys(s)) {
            const keys = path.split('/')
            let obj = this.success
            for (let i = 1; i < keys.length - 1; i++) {
              if (obj[keys[i]] == null) {
                obj[keys[i]] = {}
              }
              obj = obj[keys[i]]
            }
            obj[keys[keys.length - 1]] = s[path]
          }
        }
      }
    } else {
      // Hue API v2 response.
      for (const id in response.body.data) {
        const d = response.body.data[id]
        if (d.rtype != null && d.rid != null) {
          if (this.success[d.rtype] == null) {
            this.success[d.rtype] = {}
          }
          this.success[d.rtype][d.rid] = {}
        }
      }
      for (const id in response.body.errors) {
        const e = response.body.errors[id]
        if (e != null && typeof e === 'object' && e.description !== '') {
          this.errors.push(new HueError(e, response))
        }
      }
    }
  }
}

export { HueResponse }
