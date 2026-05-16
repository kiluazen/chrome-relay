#!/usr/bin/env node

import { buildProgram } from "./program.js";

buildProgram().parseAsync(process.argv);
