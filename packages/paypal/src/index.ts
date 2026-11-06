export * from './types';
export * from './errors';
export * from './sandbox';
export * from './simulated';
export * from './webhooks';

import { SandboxGateway, type SandboxOptions } from './sandbox';
import { SimulatedGateway, type SimulatedOptions } from './simulated';
import type { PaymentsGateway } from './types';

export function createGateway(
  mode: 'sandbox' | 'simulated',
  opts: { sandbox?: SandboxOptions; simulated?: SimulatedOptions },
): PaymentsGateway {
  if (mode === 'sandbox') {
    if (!opts.sandbox) throw new Error('sandbox options required');
    return new SandboxGateway(opts.sandbox);
  }
  return new SimulatedGateway(opts.simulated);
}
