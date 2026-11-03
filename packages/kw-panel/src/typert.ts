import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types';
import remote from './remote.ts';

export const TYPERT: TypertContribution = {
  package: '@kwagent/kw-panel', face: 'host', schemas: [],
  model: { services: [], events: [], objects: [] }, invocations: remote.descriptors,
};
