// Tests for valid branching (A->B, A->C), then adds diamond (B->D, C->D) and ensures things break, even when we then remove B
import { it } from "node:test";
import { describeOrchestrator } from "./utils/describeOrchestrator.mts";
import assert from "node:assert";
import AssertBuildStatus from "./utils/assertBuildStatus.mts";

type ItemIds = 'A' | 'B' | 'C' | 'D'
type Metadata = {}
type CustomErrorCodes = never

describeOrchestrator<ItemIds, Metadata, CustomErrorCodes>("Given diamond shaped items A, B, C, D", ({orchestrator, buildersContainer, buildImmediate}) => {
    it("Should add initial items without issues", async () => {
        await buildersContainer.AddEntrypoint('A');
        assert(orchestrator.BuildReport.A, 'Item A did not register');
        await buildersContainer.AddEntrypoint('B', 'A');
        assert(orchestrator.BuildReport.B, 'Item B did not register');
        await buildersContainer.AddEntrypoint('C', 'A');
        assert(orchestrator.BuildReport.C, 'Item C did not register');
        await buildersContainer.AddEntrypoint('D', 'B', 'C');
        assert(orchestrator.BuildReport.D, 'Item D did not register');
    })
    
    it("Should successfully build once", async () => {
        assert((await buildImmediate()), 'Failed to build');
    });

    it("Should rebuild only the changed item and its dependencies", async () => {
        buildersContainer.TriggerEntrypointChange('C');
        assert((await buildImmediate()), 'Failed to build');

        AssertBuildStatus(orchestrator, {
            A: 'built-cached',
            B: 'built-cached',
            C: 'built-full',
            D: 'built-full',
        });
    });

    it("Should fail if any specific item fails", async () => {
        buildersContainer.SetBuildItem('B', {
            state: 'error',
            errors: [{
                errorType: 'compile-error',
                errorCode: 'unknown-error',
                message: 'This item should fail'
            }]
        });
        assert(!(await buildImmediate()), 'Build should have failed');

        AssertBuildStatus(orchestrator, {
            A: 'built-any',
            B: 'errored',
            C: 'built-any',
            D: 'errored',
        });
    });

    it("Should fail if any specific item is interrupted", async () => {
        buildersContainer.SetBuildItem('B', undefined);
        const build = buildImmediate();
        buildersContainer.TriggerEntrypointChange('B');
        assert(!(await build), 'Build should have failed');

        AssertBuildStatus(orchestrator, {
            A: 'built-any',
            B: 'errored',
            D: 'errored'
        });
    });

    it("Should succeed if an item is removed before finishing build/added during build", async () => {
        buildersContainer.SetBuildItem('D', undefined);
        const build = buildImmediate();
        await buildersContainer.RemoveEntrypoint('D');
        assert((await build), 'Failed to build');
        
        buildersContainer.SetBuildItem('A', undefined);
        const build2 = buildImmediate();
        await buildersContainer.AddEntrypoint('D', 'B', 'C');
        buildersContainer.ReleaseHangingItem('A');
        assert((await build2), 'Failed to build');

        AssertBuildStatus(orchestrator, {
            A: 'built-any',
            B: 'built-any',
            C: 'built-any',
            D: 'built-full'
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

    it("Should fail if a dependency loop exists", async () => {
        buildersContainer.UpdateEntrypointDependencies('A', 'D');
        assert(!(await buildImmediate()), 'Build should have failed');

        AssertBuildStatus(orchestrator, {
            A: 'errored',
            B: 'errored',
            C: 'errored',
            D: 'errored',
        })

        buildersContainer.UpdateEntrypointDependencies('A');
        assert((await buildImmediate()), 'Failed to build');
    })

    it("Should rebuild if dependencies of a built item change", async () => {
        buildersContainer.SetBuildItem('D', undefined);
        const build = buildImmediate();
        buildersContainer.UpdateEntrypointDependencies('B');
        assert(!(await build), 'Build should have failed');

        buildersContainer.UpdateEntrypointDependencies('B', 'A');
        buildersContainer.ResetBuildItem('D');
        assert((await buildImmediate()), 'Failed to build');

        AssertBuildStatus(orchestrator, {
            A: 'built-any',
            B: 'built-full',
            C: 'built-any',
            D: 'built-full',
        })
    })
    
    it("Should continue building if a planned item's dependencies are altered", async () => {
        buildersContainer.SetBuildItem('B', undefined);
        const build = buildImmediate();
        buildersContainer.UpdateEntrypointDependencies('D', 'C');
        buildersContainer.ReleaseHangingItem('B');
        assert((await build), 'Failed to build');

        buildersContainer.UpdateEntrypointDependencies('D', 'B', 'C');
        buildersContainer.ResetBuildItem('B');
        assert((await buildImmediate()), 'Failed to build');
    })
})