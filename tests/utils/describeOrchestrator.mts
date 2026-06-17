import { after, describe, mock } from 'node:test';
import BuildOrchestrator from '../../main.mts';
import type { BuilderBuildResult, BuilderInstance, BuildStatusCode, EntrypointChanged } from '../../main.mts';

export class MockBuildersContainer<ItemIds extends string, Metadata extends object, ErrorCode extends string> {
    private readonly _entrypointDependencies = new Map<ItemIds, ItemIds[]>();
    private readonly _entrypointBuildData = new Map<ItemIds, BuilderBuildResult<Metadata, ErrorCode>>
    private readonly _entrypointTriggerChange = new Map<ItemIds, (change: Extract<EntrypointChanged, 'changed' | 'dependencies-changed'>) => void>();

    private readonly _orchestrator: BuildOrchestrator<ItemIds, Metadata, ErrorCode>;
    public constructor(orchestrator: BuildOrchestrator<ItemIds, Metadata, ErrorCode>) {
        this._orchestrator = orchestrator
    }

    private readonly DefaultBuildResult = {
        state: 'built',
        buildStyle: 'full',
    } satisfies BuilderBuildResult<Metadata, ErrorCode>

    public AddEntrypoint(itemId: ItemIds, initialDependencies: ItemIds[] = []) {
        this._entrypointDependencies.set(itemId, initialDependencies);
        this._entrypointBuildData.set(itemId, this.DefaultBuildResult)
        return this._orchestrator.AddEntrypoint(itemId, (itemId, prod) => ({
            builderType: `mock-builder`,
            itemId,
            dependencies: () => this._entrypointDependencies.get(itemId)!,
            watch: async callback => {
                this._entrypointTriggerChange.set(itemId, callback);
            },
            build: this.BuildItem(itemId),
            dispose: async () => {
                this._entrypointDependencies.delete(itemId);
                this._entrypointBuildData.delete(itemId);
                this._entrypointTriggerChange.delete(itemId);
            },
        }));
    }

    private BuildItem(itemId: ItemIds): BuilderInstance<ItemIds, Metadata, ErrorCode>['build'] {
        return async () => new Promise((resolve) => {
            const result = this._entrypointBuildData.get(itemId);
            if (result) resolve(result);
        });
    }

    public SetBuildItem(itemId: ItemIds, result?: BuilderBuildResult<Metadata, ErrorCode>) {
        if (result) this._entrypointBuildData.set(itemId, result);
        else this._entrypointBuildData.delete(itemId);
    }

    public RemoveEntrypoint(itemId: ItemIds) {
        return this._orchestrator.RemoveEntrypoint(itemId);
    }

    public TriggerEntrypointChange(itemId: ItemIds) {
        this._entrypointTriggerChange.get(itemId)!('changed');
    }

    public UpdateEntrypointDependencies(itemId: ItemIds, dependencies: ItemIds[]) {
        this._entrypointDependencies.set(itemId, dependencies);
        this._entrypointTriggerChange.get(itemId)!('dependencies-changed');
    }
}


export async function describeOrchestrator<ItemIds extends string, Metadata extends object, ErrorCode extends string>(
    description: string,
    tester: ({
        orchestrator,
        buildersContainer,
        buildImmediate,
    }: {
        orchestrator: BuildOrchestrator<ItemIds, Metadata, ErrorCode>
        buildersContainer: MockBuildersContainer<ItemIds, Metadata, ErrorCode>
        buildImmediate: () => Promise<boolean>
    }) => void,
    { debounceMs, prod }: { debounceMs: number; prod: boolean } = { debounceMs: 10, prod: false },
) {
    describe(description, () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const orchestrator = new BuildOrchestrator<ItemIds, Metadata, ErrorCode>(prod, true, debounceMs);

        after(() => {
            orchestrator.Dispose()
            mock.timers.reset();
        });

        tester({
            orchestrator,
            buildersContainer: new MockBuildersContainer<ItemIds, Metadata, ErrorCode>(orchestrator),
            buildImmediate: async () => {
                let result: boolean | undefined;
                const onStatus = (status: BuildStatusCode) => {
                    if (status === 'finished') result = true;
                    if (status === 'interrupted') result = false;
                };
                orchestrator.Events.on('build-status-changed', onStatus);
                try {
                    mock.timers.tick(debounceMs);
                    while (orchestrator.IsCurrentlyBuilding) {
                        await new Promise<void>(resolve => setImmediate(resolve));
                    }
                    return result ?? orchestrator.IsValid;
                } finally {
                    orchestrator.Events.off('build-status-changed', onStatus);
                }
            },
        });
    });
}
