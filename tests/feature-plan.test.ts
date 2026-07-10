import { describe, expect, it } from "vitest";
import { featureExecutionWaves, parseFeaturePlan } from "../src/orchestrator/feature-plan.js";

describe("feature plan", () => {
  it("normalizes a Judge feature manifest and builds dependency waves", () => {
    const plan = parseFeaturePlan({
      version: 1,
      features: [
        { id: "ui", title: "Game UI", description: "Render board and controls", depends_on: [] },
        { id: "engine", title: "Game engine", description: "Implement board rules", depends_on: [] },
        { id: "integration", title: "Integration", description: "Connect UI and engine", depends_on: ["ui", "engine"] }
      ]
    });

    expect(plan.features[0]).toEqual({
      id: "ui",
      title: "Game UI",
      description: "Render board and controls",
      depends_on: []
    });
    expect(featureExecutionWaves(plan).map((wave) => wave.map((feature) => feature.id))).toEqual([
      ["ui", "engine"],
      ["integration"]
    ]);
  });

  it("rejects duplicate, missing, self, and cyclic dependencies", () => {
    expect(() => parseFeaturePlan({
      version: 1,
      features: [
        { id: "ui", title: "UI", description: "One", depends_on: [] },
        { id: "ui", title: "Duplicate", description: "Two", depends_on: [] }
      ]
    })).toThrow("Duplicate feature id: ui");

    expect(() => parseFeaturePlan({
      version: 1,
      features: [
        { id: "ui", title: "UI", description: "One", depends_on: ["engine"] }
      ]
    })).toThrow("Feature ui depends on unknown feature: engine");

    expect(() => parseFeaturePlan({
      version: 1,
      features: [
        { id: "ui", title: "UI", description: "One", depends_on: ["ui"] }
      ]
    })).toThrow("Feature ui cannot depend on itself");

    expect(() => parseFeaturePlan({
      version: 1,
      features: [
        { id: "ui", title: "UI", description: "One", depends_on: ["engine"] },
        { id: "engine", title: "Engine", description: "Two", depends_on: ["ui"] }
      ]
    })).toThrow("Feature dependency cycle: engine, ui");
  });

  it("bounds feature fan-out and accepts safe stable ids only", () => {
    expect(() => parseFeaturePlan({
      version: 1,
      features: Array.from({ length: 9 }, (_, index) => ({
        id: `f${index + 1}`,
        title: `Feature ${index + 1}`,
        description: "Work",
        depends_on: []
      }))
    })).toThrow();

    expect(() => parseFeaturePlan({
      version: 1,
      features: [
        { id: "../escape", title: "Unsafe", description: "Work", depends_on: [] }
      ]
    })).toThrow();
  });
});
