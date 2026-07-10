import { z } from "zod";

const FeatureIdSchema = z.string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Feature ids must use lowercase letters, numbers, and hyphens only");

const FeatureDefinitionSchema = z.object({
  id: FeatureIdSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  depends_on: z.array(FeatureIdSchema).default([])
});

const FeaturePlanSchema = z.object({
  version: z.literal(1),
  features: z.array(FeatureDefinitionSchema).min(1).max(8)
});

export type FeatureDefinition = z.infer<typeof FeatureDefinitionSchema>;
export type FeaturePlan = z.infer<typeof FeaturePlanSchema>;

export function parseFeaturePlan(input: unknown): FeaturePlan {
  const plan = FeaturePlanSchema.parse(input);
  const ids = new Set<string>();

  for (const feature of plan.features) {
    if (ids.has(feature.id)) {
      throw new Error(`Duplicate feature id: ${feature.id}`);
    }
    ids.add(feature.id);
  }

  for (const feature of plan.features) {
    const dependencies = new Set<string>();
    for (const dependency of feature.depends_on) {
      if (dependency === feature.id) {
        throw new Error(`Feature ${feature.id} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new Error(`Feature ${feature.id} depends on unknown feature: ${dependency}`);
      }
      if (dependencies.has(dependency)) {
        throw new Error(`Feature ${feature.id} has duplicate dependency: ${dependency}`);
      }
      dependencies.add(dependency);
    }
  }

  const waves = buildWaves(plan);
  if (waves.flat().length !== plan.features.length) {
    const scheduled = new Set(waves.flat().map((feature) => feature.id));
    const cycle = plan.features
      .filter((feature) => !scheduled.has(feature.id))
      .map((feature) => feature.id)
      .sort();
    throw new Error(`Feature dependency cycle: ${cycle.join(", ")}`);
  }

  return plan;
}

export function featureExecutionWaves(plan: FeaturePlan): FeatureDefinition[][] {
  return buildWaves(plan);
}

function buildWaves(plan: FeaturePlan): FeatureDefinition[][] {
  const completed = new Set<string>();
  const remaining = new Set(plan.features.map((feature) => feature.id));
  const waves: FeatureDefinition[][] = [];

  while (remaining.size > 0) {
    const wave = plan.features.filter((feature) => (
      remaining.has(feature.id)
      && feature.depends_on.every((dependency) => completed.has(dependency))
    ));
    if (wave.length === 0) {
      break;
    }

    waves.push(wave);
    for (const feature of wave) {
      remaining.delete(feature.id);
      completed.add(feature.id);
    }
  }

  return waves;
}
