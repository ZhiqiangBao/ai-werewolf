import { CORE_OPTIONS } from '../options';
import { registerCoreOptions, registerCoreSteps, registerInterrupt } from '../registry';
import { daySteps } from './day';
import { deathSteps } from './deaths';
import { explodeInterrupt, explodeSteps } from './explode';
import { nightSteps } from './night';
import { sheriffSteps, withdrawInterrupt } from './sheriff';

let registered = false;

export function registerCore(): void {
  if (registered) return;
  registered = true;
  registerCoreSteps({ ...nightSteps, ...daySteps, ...deathSteps, ...sheriffSteps, ...explodeSteps });
  registerCoreOptions(CORE_OPTIONS);
  registerInterrupt(explodeInterrupt);
  registerInterrupt(withdrawInterrupt);
}
