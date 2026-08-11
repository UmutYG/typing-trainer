import { describe, it, expect } from "vitest";
import { SkillModel, MODEL_VERSION, newStat, type SerializedModel } from "../src/core/model";

/**
 * The model is months of keystrokes and cannot be rebuilt, so loading it has to
 * survive anything an older release, or a half-written record, throws at it.
 */
describe("loading a model saved by an older version", () => {
  it("fills in fields that did not exist yet", () => {
    // exactly the shape v1 wrote: no confusions, no transposed
    const v1 = {
      version: 1,
      bigrams: {
        th: { count: 12, mean: 140, m2: 30, attempts: 12, errors: 2, rollover: 5, last: 1000 },
      },
    } as unknown as SerializedModel;

    const m = SkillModel.deserialize(v1);
    const s = m.bigrams.get("th")!;
    expect(s.count).toBe(12);
    expect(s.mean).toBe(140);
    expect(s.errors).toBe(2);
    // new fields arrive with neutral defaults rather than undefined
    expect(s.confusions).toEqual({});
    expect(s.transposed).toBe(0);
  });

  it("keeps the numbers exactly as they were — no silent reset", () => {
    const m = new SkillModel();
    for (let i = 0; i < 30; i++) m.recordSample("th", 120, true);
    m.recordErrors("th", 4, { wrongChars: ["r"], transposed: true });

    const round = SkillModel.deserialize(JSON.parse(JSON.stringify(m.serialize())));
    const a = m.bigrams.get("th")!;
    const b = round.bigrams.get("th")!;
    expect(b.mean).toBeCloseTo(a.mean, 10);
    expect(b.count).toBe(a.count);
    expect(b.errors).toBe(a.errors);
    expect(b.transposed).toBe(a.transposed);
    expect(b.confusions).toEqual(a.confusions);
  });

  it("stamps the current version on save", () => {
    expect(new SkillModel().serialize().version).toBe(MODEL_VERSION);
  });

  it("skips a corrupt entry instead of losing the whole model", () => {
    const mixed = {
      version: 1,
      bigrams: {
        th: { ...newStat(), count: 9, mean: 130 },
        broken: null,
        alsoBroken: { mean: "fast" },
        er: { ...newStat(), count: 4, mean: 110 },
      },
    } as unknown as SerializedModel;

    const m = SkillModel.deserialize(mixed);
    expect(m.bigrams.has("th")).toBe(true);
    expect(m.bigrams.has("er")).toBe(true);
    expect(m.bigrams.has("broken")).toBe(false);
    expect(m.bigrams.has("alsoBroken")).toBe(false);
    expect(m.bigrams.size).toBe(2);
  });

  it("survives an empty or malformed payload without throwing", () => {
    expect(SkillModel.deserialize({ version: 1, bigrams: {} }).bigrams.size).toBe(0);
    expect(SkillModel.deserialize({} as SerializedModel).bigrams.size).toBe(0);
  });
});
