import { z } from 'zod';
import { parameterValueSchema } from './parameters';

export const classificationResultSchema = z.object({
  actions: z.record(z.string(), z.record(z.string(), parameterValueSchema)).optional().default({}),
});

/**
 * The classifier contract as a JSON Schema, for providers that can enforce one.
 *
 * Written by hand rather than derived from `classificationResultSchema`, because
 * `parameterValueSchema` is a wide union - every scalar, every array of them, and the
 * multimodal image and audio shapes - and mirroring all of it would put hundreds of
 * tokens into every turn of a live call for no gain. Parameters stay unconstrained
 * here; `classificationResultSchema` is what actually validates the response.
 *
 * What this schema DOES pin is the part that matters: there is always an `actions`
 * object, so "no action" is something the model states rather than something we infer
 * from output we could not read.
 */
export const classificationOutputJsonSchema = {
  type: 'object',
  properties: {
    actions: {
      type: 'object',
      description: 'Actions to trigger, keyed by action name, each mapping to an object of that action\'s parameters. Use an empty object when no action applies.',
      additionalProperties: { type: 'object', additionalProperties: true },
    },
  },
  required: ['actions'],
} as const;

export const actionClassificationResultSchema = z.object({
  name: z.string(),
  parameters: z.record(z.string(), parameterValueSchema),
});

export type ActionClassificationResult = z.infer<typeof actionClassificationResultSchema>;

export const actionClassificationResultWithClassifierSchema = z.object({
  classifierId: z.string(),
  classifierName: z.string(),
  actions: z.array(actionClassificationResultSchema),
});

export type ActionClassificationResultWithClassifier = z.infer<typeof actionClassificationResultWithClassifierSchema>;

export const sampleCopyClassificationResultSchema = z.object({
  sampleCopy: z.string()
});

/** The sample-copy contract as a JSON Schema, for providers that can enforce one. */
export const sampleCopyOutputJsonSchema = {
  type: 'object',
  properties: {
    sampleCopy: { type: 'string', description: 'The selected sample copy, verbatim.' },
  },
  required: ['sampleCopy'],
} as const;

export type SampleCopyClassificationResult = z.infer<typeof sampleCopyClassificationResultSchema>;
