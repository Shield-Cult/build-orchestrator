import { after, afterEach, describe, mock } from 'node:test';
import BuildOrchestrator from '../../main.mts';
import type { BuilderBuildResult, BuilderInstance, BuildStatusCode, EntrypointChanged } from '../../main.mts';

export class MockBuildersContainer<ItemIds extends string, Metadata extends object, ErrorCode extends string> {
    private readonly _entrypointDependencies = new Map<ItemIds, ItemIds[]>();
    private readonly _entrypointBuildData = new Map<ItemIds, BuilderBuildResult<Metadata, ErrorCode>>
    private readonly _entrypointTriggerChange = new Map<ItemIds, (change: Extract<EntrypointChanged, 'changed' | 'dependencies-changed'>) => void>();
    private readonly _entrypointReleaseHanging = new Map<ItemIds, (result: BuilderBuildResult<Metadata, ErrorCode>) => void>;

    private readonly _orchestrator: BuildOrchestrator<ItemIds, Metadata, ErrorCode>;
    public constructor(orchestrator: BuildOrchestrator<ItemIds, Metadata, ErrorCode>) {
        this._orchestrator = orchestrator
    }

    private readonly DefaultBuildResult = {
        state: 'built',
        buildStyle: 'full',
    } satisfies BuilderBuildResult<Metadata, ErrorCode>

    public async AddEntrypoint(itemId: ItemIds, initialDependencies: ItemIds[] = []) {
        await this.RemoveEntrypoint(itemId);
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
                this._entrypointReleaseHanging.delete(itemId);
            },
        }));
    }

    private BuildItem(itemId: ItemIds): BuilderInstance<ItemIds, Metadata, ErrorCode>['build'] {
        return async () => new Promise((resolve) => {
            const result = this._entrypointBuildData.get(itemId);
            if (result) resolve(result);
            else this._entrypointReleaseHanging.set(itemId, resolve);
        });
    }

    public SetBuildItem(itemId: ItemIds, result?: BuilderBuildResult<Metadata, ErrorCode>) {
        if (result) this._entrypointBuildData.set(itemId, result);
        else this._entrypointBuildData.delete(itemId);
        this.TriggerEntrypointChange(itemId);
    }

    public ResetBuildItem(itemId: ItemIds) {
        this._entrypointBuildData.set(itemId, this.DefaultBuildResult);
        this.TriggerEntrypointChange(itemId);
    }

    public ReleaseHangingItem(itemId: ItemIds, result?: BuilderBuildResult<Metadata, ErrorCode>) {
        this._entrypointReleaseHanging.get(itemId)?.(result ?? this.DefaultBuildResult);
    }

    public ResetAllItems() {
        [...this._entrypointTriggerChange.keys()].forEach(key => {
            this.ResetBuildItem(key);
        })
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
        const buildersContainer = new MockBuildersContainer<ItemIds, Metadata, ErrorCode>(orchestrator);

        const buildImmediate = async () => {
            let result: boolean | undefined;
            const onStatus = (status: BuildStatusCode) => {
                if (status === 'finished') result = true;
                if (status === 'interrupted') result = false;
            };
            orchestrator.Events.on('build-status-changed', onStatus);
            try {
                mock.timers.tick(debounceMs);
                while (orchestrator.IsCurrentlyBuilding && result === undefined) {
                    await new Promise<void>(resolve => setImmediate(resolve));
                }
                return result ?? orchestrator.IsValid;
            } finally {
                orchestrator.Events.off('build-status-changed', onStatus);
            }
        };

        afterEach(async () => {
            buildersContainer.ResetAllItems();
            await buildImmediate();
        });

        after(() => {
            orchestrator.Dispose()
            mock.timers.reset();
        });

        tester({
            orchestrator,
            buildersContainer,
            buildImmediate,
        });
    });
}
