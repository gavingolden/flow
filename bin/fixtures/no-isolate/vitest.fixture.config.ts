import * as path from "node:path";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const root = path.resolve(import.meta.dirname, "../../..");

class PathSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  root,
  test: {
    include: ["bin/fixtures/no-isolate/*.case.ts"],
    setupFiles: [path.join(root, "vitest.setup.ts")],
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { sequencer: PathSequencer },
  },
});
