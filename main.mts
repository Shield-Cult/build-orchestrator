export function Debouncer<Params extends unknown[]>(callback: (...params: Params) => unknown, timeoutMs: number) {
    let timeout: NodeJS.Timeout | undefined = undefined
    return {
        Exec: (...params: Params) => (timeout?.close(), timeout = setTimeout(() => callback(...params), timeoutMs)),
        Terminate: () => (timeout?.close(), timeout = undefined),
    }
}

type Debouncer<Params extends unknown[] = []> = ReturnType<typeof Debouncer<Params>>;

// Allow adding new entrypoints/deps in real time (forces rebuild)
// Allow rebuild debounce

export type BuildResult<Metadata extends object> = Partial<Metadata> &
    (
        | {
            state: 'built'
            // Full - full build, cached - didn't change => skipped
            buildStyle: 'full' | 'cached'
        }
        | {
            state: 'error'
            errors: BuildError[]
        }
    )

export type BuildStatus<ItemId extends string, Metadata extends object> = {
    /** The last _successful_ build id - does not update when the build errors even as the rest of the data does */
    _lastBuildId: number
    _lastChangedBuildId: number
    _buildData:
    {
        // The builder that processed this entrypoint 
        builder: ReturnType<Builder<ItemId, Metadata>>
    } &
    (
        | {
            // This state can only happen before the first build
            state: 'pending'
        }
        | BuildResult<Metadata>
    )
}

export type BuildError = {
    errorType: 'compile-error' | 'validation-error' | 'dependency-failure';
    message: string;
    location?: string;
}

/**
 * The different changes that can occur to an entrypoint
 * 
 * - discovered - register as new entrypoint and force clear _all_ caches
 * - changed - rebuild entrypoint and all of its dependencies
 * - dependencies-changed - refresh dependencies cache for entrypoint and then rebuild
 * - deleted - entrypoint deleted - remove any reference in all caches
 */
export type EntrypointChanged = 'discovered' | 'changed' | 'dependencies-changed' | 'deleted'

export type Builder<ItemId extends string, Metadata extends object> = (ItemId: ItemId, prod: boolean) => {
    builderId: string;
    itemId: ItemId;
    dependencies: () => ItemId[];
    watch: (onChange: (change: Extract<EntrypointChanged, 'changed' | 'dependencies-changed'>) => void) => Promise<void>;
    build: (metadata: Partial<Metadata>) => Promise<BuildResult<Metadata>>
    dispose: (metadata: Partial<Metadata>) => Promise<void>
};

export default class BuildOrchestrator<ItemIds extends string, Metadata extends object> {
    private _currentBuildId = 0;
    private _lastBuildSucceeded = false;
    private _currentlyBuilding = new Map<ItemIds, AbortController>();
    private _remainingBuildItems = new Set<ItemIds>();
    private _buildStatus: {
        [Key in ItemIds]?: BuildStatus<Key, Metadata>
    } = {};

    private _dependsOn: {
        [Key in ItemIds]?: Set<ItemIds>
    } = {};
    private _usedBy: {
        [Key in ItemIds]?: Set<ItemIds>
    } = {};

    private _buildDebounce;

    public constructor(
        private readonly prod: boolean,
        private readonly watch: boolean,
        debounceMs: number,
    ) {
        this._buildDebounce = Debouncer(() => this.StartBuild(), debounceMs);
    }

    public get IsCurrentlyBuilding() {
        return this._currentlyBuilding.size > 0 || this._remainingBuildItems.size > 0;
    }

    public get BuildReport(): { readonly [Key in ItemIds]?: Readonly<BuildStatus<Key, Metadata>> } {
        return this._buildStatus;
    }

    public get IsValid() {
        return !this.IsCurrentlyBuilding && this._lastBuildSucceeded;
    }

    public ForceRebuild() {
        this.InterruptBuild();
        const allItems = Object.keys(this._buildStatus) as ItemIds[];
        allItems.forEach(itemId => this._buildStatus[itemId]!._lastChangedBuildId = this._currentBuildId + 1);
        this._buildDebounce.Exec();
    }

    private StartBuild() {
        // We can't start a build while we're already in the middle of one
        if(this.IsCurrentlyBuilding) return;
        // Increment the build id
        this._currentBuildId++;
        const allItems = Object.keys(this._buildStatus) as ItemIds[];
        const rootItems = allItems.filter(itemId => !this._dependsOn[itemId]);
        
        // Mark all items as planned for building
        allItems.forEach(itemId => this._remainingBuildItems.add(itemId));        
        // Initiate build for all root entry points
        rootItems.forEach(itemId => this.TryRebuildEntrypoint(itemId));
        // Try to finish the build (for cases where no root entrypoints were found)
        this.TryFinishBuild();
    }

    private TryRebuildEntrypoint<ItemId extends ItemIds>(itemId: ItemId) {
        const dependsOn = this._dependsOn[itemId];
        // If there exists a dependency which is still not built, OR missing, OR errored on its last build - we cannot build ourselves
        if ([...dependsOn ?? []].find(dep => this._remainingBuildItems.has(dep) || !this._buildStatus[dep] || this._buildStatus[dep]._buildData.state === 'error')) {
            return;
        }

        // This should always exist
        const status = this._buildStatus[itemId]!;
        const builder = status._buildData.builder;

        if (this._remainingBuildItems.delete(itemId)) {
            // Can the build be cached
            if (status._lastBuildId >= status._lastChangedBuildId) {
                status._lastBuildId = this._currentBuildId;
                const report = {
                    state: "built",
                    buildStyle: "cached",
                } satisfies BuildResult<Metadata>;

                status._buildData = {
                    ...status._buildData,
                    ...report,
                }

                this.OnEntrypointBuilt(itemId);
            }
            // If it cannot be cached, initiate a full build
            else {
                const abortController = new AbortController();
                this._currentlyBuilding.set(itemId, abortController);

                new Promise<BuildResult<Metadata>>((resolve, reject) => {
                    abortController.signal.addEventListener("abort", reject);
                    builder.build(status._buildData as Metadata).then(resolve, reject);
                }).then(result => {
                    status._buildData = {
                        builder,
                        ...result,
                    }

                    // If the build succeeded, we run post build normally
                    if (result.state === 'built') {
                        status._lastBuildId = this._currentBuildId;
                        this.OnEntrypointBuilt(itemId);
                    }
                    // Otherwise, we try to finish the build
                    else {
                        this.TryFinishBuild();
                    }
                }, failure => {
                    const report = {
                        state: "error",
                        errors: [{
                            errorType: "compile-error",
                            message: `An error occured - ${failure}`,
                        }]
                    } satisfies BuildResult<Metadata>;

                    status._buildData = {
                        // This can technically carry over unexpected fields, but also the build should never actually error in normal usage so it's not crucial
                        ...status._buildData,
                        ...report,
                    }

                    // Try to finish the build
                    this.TryFinishBuild();
                });
            }
        }
    }

    private OnEntrypointBuilt<ItemId extends ItemIds>(itemId: ItemId) {
        const usedBy = this._usedBy[itemId];
        if (usedBy) {
            [...usedBy].forEach((user) => this.TryRebuildEntrypoint(user));
        }
        this.TryFinishBuild();
    }

    private InterruptEntrypointBuild<ItemId extends ItemIds>(itemId: ItemId) {
        const controller = this._currentlyBuilding.get(itemId);
        if (controller) {
            controller.abort();
            this._currentlyBuilding.delete(itemId);
        }
    }

    private InterruptBuild() {
        [...this._currentlyBuilding.keys()].forEach(itemId => this.InterruptEntrypointBuild(itemId));
        this.TryFinishBuild();
    }

    private TryFinishBuild() {
        // We can't finish a build when no build is ongoing
        if (!this.IsCurrentlyBuilding) return;
        // A build can only be finished when no entrypoints are currently being built
        if (this._currentlyBuilding.size === 0) {
            // The build succeeds if no entry points errored, AND we have no remaining build items
            this._lastBuildSucceeded = this._remainingBuildItems.size === 0 && !(Object.keys(this._buildStatus) as ItemIds[]).some(itemId => this._buildStatus[itemId]!._buildData.state === "error");

            // Now, if we did have remaining build items, it means they were waiting for dependencies that never built
            // As such, we mark those appropriately
            if (!this._lastBuildSucceeded) {
                [...this._remainingBuildItems].forEach(itemId => {
                    // These should always exist
                    const status = this._buildStatus[itemId]!;
                    const dependencies = [...this._dependsOn[itemId]!];

                    const missingDeps = dependencies.filter(dep => !this._buildStatus[dep]);
                    const erroredDeps = dependencies.filter(dep => this._buildStatus[dep]?._buildData.state === "error");
                    const report = {
                        state: "error",
                        errors: [
                            missingDeps && {
                                errorType: "dependency-failure",
                                message: `The following dependencies used by this entrypoint were not located - [${missingDeps.join(", ")}]`,
                            },
                            erroredDeps && {
                                errorType: "dependency-failure",
                                message: `The following dependencies used by this entrypoint did not build correctly - [${erroredDeps.join(", ")}]`,
                            },
                        ].filter(Boolean) as BuildError[],
                    } satisfies BuildResult<Metadata>

                    status._buildData = {
                        ...status._buildData,
                        ...report,
                    }
                })
            }

            this._remainingBuildItems.clear();
        }
    }

    public async AddEntrypoint<ItemId extends ItemIds>(itemId: ItemId, builder: Builder<ItemId, Metadata>) {
        await this.RemoveEntrypoint(itemId);

        const builderInstance = builder(itemId, this.prod);
        this._buildStatus[itemId] = {
            _lastBuildId: -1,
            _lastChangedBuildId: this._currentBuildId,
            _buildData: {
                builder: builderInstance,
                state: "pending",
            }
        } satisfies BuildStatus<ItemId, Metadata>;

        this.RefreshDependencies(itemId, builderInstance.dependencies());
        if (this.watch) await builderInstance.watch((change) => this.OnEntrypointChanged(itemId, change));
        this.OnEntrypointChanged(itemId, "discovered");
    }

    public async RemoveEntrypoint<ItemId extends ItemIds>(itemId: ItemId) {
        const dependencies = this._dependsOn[itemId];
        if (dependencies) {
            [...dependencies].forEach(dep => this.RemoveDependency(dep, itemId));
        }
        delete this._dependsOn[itemId];
        this.OnEntrypointChanged(itemId, "deleted");
    }

    private RefreshDependencies<ItemId extends ItemIds>(itemId: ItemId, dependencies: ItemIds[]) {
        const oldDependencies = new Set<ItemIds>(this._dependsOn[itemId] ?? []);
        if (dependencies.length > 0) {
            dependencies.forEach(dep => {
                this._usedBy[dep] ??= new Set();
                this._usedBy[dep].add(itemId);
                oldDependencies.delete(dep);
            });
            this._dependsOn[itemId] = new Set(dependencies);
        } else {
            delete this._dependsOn[itemId];
        }

        [...oldDependencies].forEach(dep => this.RemoveDependency(dep, itemId));
    }

    private RemoveDependency(dep: ItemIds, itemId: ItemIds) {
        const set = this._usedBy[dep];
        if (set) set.delete(itemId);
        if (set && set.size === 0) delete this._usedBy[dep];
    }

    private OnEntrypointChanged<ItemId extends ItemIds>(itemId: ItemId, change: EntrypointChanged) {
        // This method only does anything significant in watch mode - to build in non-watch mode simply call build when you're ready
        if (!this.watch) return;

        const isCurrentlyBuilding = this.IsCurrentlyBuilding;

        let rebuildEntrypoint = false;
        let fullRebuild = !isCurrentlyBuilding; // If we aren't building and a change happened - rebuild

        switch (change) {
            case "dependencies-changed":
                this.RefreshDependencies(itemId, this._buildStatus[itemId]?._buildData.builder.dependencies() ?? []);
            case "changed":
                const status = this._buildStatus[itemId]!;
                if (isCurrentlyBuilding) {
                    // If we're currently building this entrypoint (or already finished it) - restart the build
                    if (this._currentlyBuilding.has(itemId) || !this._remainingBuildItems.has(itemId)) {
                        fullRebuild ||= true;
                        // In case we force a rebuild, we register this entrypoint as having changed in the next rebuild
                        status._lastChangedBuildId = this._currentBuildId + 1;
                    } else {
                        // If this entrypoint wasn't built yet - just make sure it is rebuilt
                        rebuildEntrypoint = true;
                        // In case the entrypoint wasn't built yet, we can also try to greedily set it to having changed in this build
                        status._lastChangedBuildId = this._currentBuildId;
                    }
                } else {
                    // Mark this entrypoint as changed for the next rebuild
                    status._lastChangedBuildId = this._currentBuildId + 1;
                }
                break;
            case "discovered":
                // We only care if we're currently building to update the running build - since every new build recalculates the build plan anyways
                if (isCurrentlyBuilding) {
                    // If we're currently building - simply add this entrypoint to the plan and try to build it
                    rebuildEntrypoint = true;
                }
                break;
            case "deleted":
                if (isCurrentlyBuilding) {
                    if (this._remainingBuildItems.delete(itemId)) {
                        // We successfully prevented this entrypoint from building
                    }
                    else if (this._currentlyBuilding.has(itemId)) {
                        // We successfully interrupted this entrypoint from building, the build is still salvagable
                        this.InterruptEntrypointBuild(itemId);
                    }
                    else {
                        // The entrypoint was already build and already polluted the build - force a full rebuild
                        fullRebuild = true;
                    }
                }

                // Now we can run the post-deletion logic for the entrypoing
                const buildData = this._buildStatus[itemId]!._buildData;
                const builder = buildData!.builder;
                // TODO - introduce some sort of mechanism to make sure an entrypoing can't be re-added until its dispose method finishes running
                // In practice, for now this shouldn't really cause any issues due to debounces
                builder.dispose(buildData as BuildResult<Metadata>);
                delete this._buildStatus[itemId];
        }

        if (fullRebuild) {
            if (isCurrentlyBuilding) {
                this.InterruptBuild();
            }
            this._buildDebounce.Exec();
        } else if (rebuildEntrypoint) {
            this._remainingBuildItems.add(itemId);
            this.TryRebuildEntrypoint(itemId);
        }
    }

    public Dispose() {
        this.InterruptBuild();
        this._buildDebounce.Terminate();
        (Object.keys(this._buildStatus) as ItemIds[]).forEach(itemId => this.RemoveEntrypoint(itemId));
    }
}