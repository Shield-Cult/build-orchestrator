import { it } from "node:test";
import { describeOrchestrator } from "./utils/describeOrchestrator.mts";
import assert from "node:assert";

type ItemIds = 'A' | 'B' | 'C' | 'D'
type Metadata = {}
type CustomErrorCodes = ''

describeOrchestrator<ItemIds, Metadata, CustomErrorCodes>("Given orphan items A, B, C, D", ({orchestrator, buildersContainer, buildImmediate}) => {
    it("Should add all items without issues", async () => {
        await buildersContainer.AddEntrypoint('A');
        assert(orchestrator.BuildReport.A, 'Item A did not register');
        await buildersContainer.AddEntrypoint('B');
        assert(orchestrator.BuildReport.B, 'Item B did not register');
        await buildersContainer.AddEntrypoint('C');
        assert(orchestrator.BuildReport.C, 'Item C did not register');
        await buildersContainer.AddEntrypoint('D');
        assert(orchestrator.BuildReport.D, 'Item D did not register');
    })
    
    it("Should successfully build once", async () => {
        assert((await buildImmediate()), 'Failed to build');
    });

    it("Should rebuild only the changed item", async () => {
        buildersContainer.TriggerEntrypointChange('A');
        assert((await buildImmediate()), 'Failed to build');
        assert(orchestrator.BuildReport.A!._buildData.state === 'built', 'Changed item did not rebuild');
        assert(orchestrator.BuildReport.A!._buildData.buildStyle === 'full', 'Changed item did not perform a full rebuild');

        assert(orchestrator.BuildReport.B!._buildData.state === 'built', 'Unchanged item failed to build');
        assert(orchestrator.BuildReport.B!._buildData.buildStyle === 'cached', 'Unchanged item performed a full rebuild instead of being cached');
        
        assert(orchestrator.BuildReport.C!._buildData.state === 'built', 'Unchanged item failed to build');
        assert(orchestrator.BuildReport.C!._buildData.buildStyle === 'cached', 'Unchanged item performed a full rebuild instead of being cached');
        
        assert(orchestrator.BuildReport.D!._buildData.state === 'built', 'Unchanged item failed to build');
        assert(orchestrator.BuildReport.D!._buildData.buildStyle === 'cached', 'Unchanged item performed a full rebuild instead of being cached');
    })

    // All these tests should be done on all configurations
    // Ensures that if we fail/terminate any of these entrypoints the whole build fails
    // Ensures that if we interrupt the build it stays broken until the rebuild, and that THEN the rebuild works properly
    // Ensure that removing or adding an entrypoint works as intended
})