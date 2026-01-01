// hb-hue-tools/lib/HueError.js
//
// Homebridge plug-in for Philips Hue.
// Copyright © 2018-2026 Erik Baauw. All rights reserved.

import { HttpClient } from 'hb-lib-tools/HttpClient'

// API errors that could still cause (part of) the PUT command to be executed.
const nonCriticalApiErrorTypes = [
  6, // parameter not available
  7, // invalid value for parameter
  8, // paramater not modifiable
  201 // paramater not modifiable, device is set to off
]

/** Wrapper for Hue API API error.
  * <br>See {@link ApiError}.
  * @name ApiError
  * @type {Class}
  * @memberof module:hb-hue-tools
  */

/** Hue API error.
  * @extends HttpClient.HttpError
  */
class HueError extends HttpClient.HttpError {
  /** Create a new instance of a Hue API error.
    * @param {Object} e - The `"error"` API response.
    * @param {HttpClient.HttpResponse} response - The HTTP response.
    */
  constructor (e, response) {
    if (e.type != null) {
      // Hue API v1 error.
      const a = e.address !== '' ? ': ' : ''
      super(
        `${e.address}${a}api error ${e.type}: ${e.description}`,
        response.request, response.statusCode, response.statusMessage
      )
      /** @member {integer} - The API error type.
        */
      this.type = e.type

      /** @member {string} - The address causing the error.
        */
      this.address = e.address

      /** @member {boolean} - Indication that the request might still succeed
        * for other attributes.
        */
      this.nonCritical = nonCriticalApiErrorTypes.includes(e.type)
    } else {
      // Hue API v2 error.
      super(
        e.description,
        response.request, response.statusCode, response.statusMessage
      )
    }
    /** @member {string} - The API error description.
      */
    this.description = e.description
  }
}

export { HueError }
