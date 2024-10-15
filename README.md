<span align="center">

# Homebridge Hue Tools
[![Downloads](https://img.shields.io/npm/dt/hb-hue-tools)](https://www.npmjs.com/package/hb-hue-tools)
[![Version](https://img.shields.io/npm/v/hb-hue-tools)](https://www.npmjs.com/package/hb-hue-tools)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen)](https://standardjs.com)

</span>

## Homebridge Hue Tools
Copyright © 2016-2024 Erik Baauw. All rights reserved.

### Introduction
This repository provides a standalone installation of the command-line utility from [Homebridge Hue](https://github.com/ebaauw/homebridge-hue):

- `ph`, to discover, monitor, and interact with Hue bridges.  
See the [`ph` Tutorial](https://github.com/ebaauw/homebridge-hue/wiki/ph-Tutorial) in the Wiki for more info.

`ph` takes a `-h` or `--help` argument to provide a brief overview of its functionality and command-line arguments.

### Prerequisites
You need a Philips Hue bridge to connect Homebridge Hue Tools to your Hue-compatible lights, switches, and sensors.
I recommend using the latest Hue bridge firmware, with API v1.67.0 (v2 bridge) or v1.16.0 (v1 bridge) or higher.

The Homebridge Hue tools communicate with the Hue bridge using the local v1
[Hue API](https://developers.meethue.com/develop/get-started-2/).
