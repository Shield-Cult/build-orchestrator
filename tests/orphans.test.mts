import { it } from "node:test";
import { describeOrchestrator } from "./utils/describeOrchestrator.mts";
import assert from "node:assert";
import AssertBuildStatus from "./utils/assertBuildStatus.mts";

type ItemIds = 'A' | 'B' | 'C' | 'D'
type Metadata = {}
type CustomErrorCodes = never

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

        AssertBuildStatus(orchestrator, {
            A: 'built-full',
            B: 'built-cached',
            C: 'built-cached',
            D: 'built-cached'
        });
    });

    it("Should fail if any specific item fails", async () => {
        buildersContainer.SetBuildItem('A', {
            state: 'error',
            errors: [{
                errorType: 'compile-error',
                errorCode: 'unknown-error',
                message: 'This item should fail'
            }]
        });
        assert(!(await buildImmediate()), 'Build should have failed');

        AssertBuildStatus(orchestrator, {
            A: 'errored',
            B: 'built-any',
            C: 'built-any',
            D: 'built-any',
        });
    });

    it("Should fail if any specific item is interrupted", async () => {
        buildersContainer.SetBuildItem('A', undefined);
        const build = buildImmediate();
        buildersContainer.TriggerEntrypointChange('A');
        assert(!(await build), 'Build should have failed');

        AssertBuildStatus(orchestrator, {
            A: 'errored',
        });
    });

    it("Should succeed if an item is removed before finishing build/added during build", async () => {
        buildersContainer.SetBuildItem('B', undefined);
        const build = buildImmediate();
        await buildersContainer.RemoveEntrypoint('B');
        assert((await build), 'Failed to build');
        
        buildersContainer.SetBuildItem('A', undefined);
        const build2 = buildImmediate();
        await buildersContainer.AddEntrypoint('B');
        buildersContainer.ReleaseHangingItem('A');
        assert((await build2), 'Failed to build');

        AssertBuildStatus(orchestrator, {
            A: 'built-any',
            B: 'built-any',
        });
        
        buildersContainer.ResetBuildItem('A');
        assert((await buildImmediate()), 'Rebuild should now work');
    });
    
    it("Should fail if an item is removed after it was built", async () => {
        buildersContainer.SetBuildItem('B', undefined);
        const build = buildImmediate();
        await buildersContainer.RemoveEntrypoint('A');
        assert(!(await build), 'Build should have failed');
        
        buildersContainer.ResetBuildItem('B');
        assert((await buildImmediate(), 'Failed to build'));

        await buildersContainer.AddEntrypoint('A');
        assert((await buildImmediate()), 'Rebuild should now work');
    });
})