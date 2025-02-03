import { assertUnreachable } from "@actor-core/common/utils";
import type { ActorTags, BuildTags } from "@actor-core/common/utils";
import type { ManagerDriver } from "@actor-core/manager-runtime";
import type {
	ActorsRequest,
	ActorsResponse,
} from "@actor-core/manager-protocol";
import type { CreateRequest } from "@actor-core/manager-protocol/query";
import { logger } from "./log";
import { type RivetClientConfig, rivetRequest } from "./rivet_client";

	// biome-ignore lint/suspicious/noExplicitAny: will add api types later
type RivetActor = any;
	// biome-ignore lint/suspicious/noExplicitAny: will add api types later
type RivetBuild = any;

export interface ActorState {
	tags: ActorTags;
	destroyedAt?: number;
}

export function buildManager(
	clientConfig: RivetClientConfig,
): ManagerDriver {
	return {
		async queryActor({ query }: ActorsRequest): Promise<ActorsResponse> {
			logger().debug("query", { query });
			if ("getForId" in query) {
				// Get actor
				const res = await rivetRequest<void, { actor: RivetActor }>(
					clientConfig,
					"GET",
					`/actors/${encodeURIComponent(query.getForId.actorId)}`,
				);

				// Validate actor
				if ((res.actor.tags as ActorTags).access !== "public") {
					// TODO: Throw 404 that matches the 404 from Fern if the actor is not found
					throw new Error(`Actor with ID ${query.getForId.actorId} is private`);
				}
				if (res.actor.destroyedAt) {
					throw new Error(
						`Actor with ID ${query.getForId.actorId} already destroyed`,
					);
				}

				return res.actor;
			}
			if ("getOrCreateForTags" in query) {
				const tags = query.getOrCreateForTags.tags;
				if (!tags) throw new Error("Must define tags in getOrCreateForTags");
				const existingActor = await getWithTags(
					clientConfig,
					tags as ActorTags,
				);
				if (existingActor) {
					// Actor exists
					return existingActor;
				}

				if (query.getOrCreateForTags.create) {
					// Create if needed
					return await createActor(
						clientConfig,
						query.getOrCreateForTags.create,
					);
				}
				// Creation disabled
				throw new Error("Actor not found with tags or is private.");
			}
			if ("create" in query) {
				return await createActor(clientConfig, query.create);
			}
			assertUnreachable(query);
		},
	};
}

async function getWithTags(
	clientConfig: RivetClientConfig,
	tags: ActorTags,
): Promise<RivetActor | undefined> {
	const tagsJson = JSON.stringify({
		...tags,
		access: "public",
	});
	let { actors } = await rivetRequest<void, { actors: RivetActor[] }>(
		clientConfig,
		"GET",
		`/actors?tags_json=${encodeURIComponent(tagsJson)}`,
	);

	// TODO(RVT-4248): Don't return actors that aren't networkable yet
	actors = actors.filter((a: RivetActor) => {
		// This should never be triggered. This assertion will leak if private actors exist if it's ever triggered.
		if ((a.tags as ActorTags).access !== "public") {
			throw new Error("unreachable: actor tags not public");
		}

		for (const portName in a.network.ports) {
			const port = a.network.ports[portName];
			if (!port.hostname || !port.port) return false;
		}
		return true;
	});

	if (actors.length === 0) {
		return undefined;
	}

	// Make the chosen actor consistent
	if (actors.length > 1) {
		actors.sort((a: RivetActor, b: RivetActor) => a.id.localeCompare(b.id));
	}

	return actors[0];
}

async function createActor(
	clientConfig: RivetClientConfig,
	createRequest: CreateRequest,
): Promise<RivetActor> {
	// Verify build access
	const build = await getBuildWithTags(clientConfig, {
		name: createRequest.tags.name,
		current: "true",
		access: "public",
	});
	if (!build) throw new Error("Build not found with tags or is private");

	// Create actor
	const req = {
		tags: {
			...createRequest.tags,
			access: "public",
		},
		build: build.id,
		region: createRequest.region,
		network: {
			ports: {
				http: {
					protocol: "https",
					routing: { guard: {} },
				},
			},
		},
	};
	logger().info("creating actor", { ...req });
	const { actor } = await rivetRequest<typeof req, { actor: RivetActor }>(
		clientConfig,
		"POST",
		"/actors",
		req,
	);
	return actor;
}

async function getBuildWithTags(
	clientConfig: RivetClientConfig,
	buildTags: BuildTags,
): Promise<RivetBuild | undefined> {
	const tagsJson = JSON.stringify(buildTags);
	let { builds } = await rivetRequest<void, { builds: RivetBuild[] }>(
		clientConfig,
		"GET",
		`/builds?tags_json=${encodeURIComponent(tagsJson)}`,
	);

	builds = builds.filter((b: RivetBuild) => {
		// Filter out private builds
		if ((b.tags as BuildTags).access !== "public") return false;

		return true;
	});

	if (builds.length === 0) {
		return undefined;
	}
	if (builds.length > 1) {
		builds.sort((a: RivetBuild, b: RivetBuild) => a.id.localeCompare(b.id));
	}

	return builds[0];
}
