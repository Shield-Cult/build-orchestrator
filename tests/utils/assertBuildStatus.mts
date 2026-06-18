import assert from "node:assert";
import BuildOrchestrator from "../../main.mts";

export type AssertBuildStatusCode = 'built-full' | 'built-cached' | 'built-any' | 'errored' | 'pending';

export default function AssertBuildStatus<ItemIds extends string, Metadata extends object, ErrorCode extends string>(orchestrator: BuildOrchestrator<ItemIds, Metadata, ErrorCode>, items: { [Key in ItemIds]?: AssertBuildStatusCode }) {
    (Object.keys(items) as ItemIds[]).forEach(itemId => {
        const status = items[itemId] satisfies AssertBuildStatusCode | undefined;
        const buildStatus = orchestrator.BuildReport[itemId];
        assert(buildStatus, `Item ${itemId} not found in build report`);
        switch (status) { 
            case 'built-any':
                assert(buildStatus._buildData.state === 'built', `Item ${itemId} was not built`);
                break;
            case 'built-full':
                assert(buildStatus._buildData.state === 'built', `Item ${itemId} was not built`);
                assert(buildStatus._buildData.buildStyle === 'full', `Item ${itemId} was not fully rebuilt`);
                break;
            case 'built-cached':
                assert(buildStatus._buildData.state === 'built', `Item ${itemId} was not built`);
                assert(buildStatus._buildData.buildStyle === 'cached', `Item ${itemId} was not cached`);
                break;
            case 'errored':
                assert(buildStatus._buildData.state === 'error', `Item ${itemId} was not errored`);
                assert(buildStatus._buildData.errors.length > 0, `Item ${itemId} had no errors`);
                break;
            case 'pending':
                assert(buildStatus._buildData.state === 'pending', `Item ${itemId} should still be pending its first build`);
                break;
        }
    });
}