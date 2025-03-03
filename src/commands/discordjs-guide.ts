import { FetchUserAgent } from '#constants/constants';
import { DjsGuideIcon } from '#constants/emotes';
import { RedisKeys } from '#lib/redis-cache/RedisCacheClient';
import type { AlgoliaSearchResult, DocsearchHit } from '#types/Algolia';
import { buildHierarchicalName, buildResponseContent } from '#utils/algolia-utils';
import { errorResponse } from '#utils/response-utils';
import { getGuildIds } from '#utils/utils';
import { hideLinkEmbed, hyperlink, inlineCode } from '@discordjs/builders';
import { fetch, FetchMethods, FetchResultTypes } from '@sapphire/fetch';
import { cutText, isNullishOrEmpty } from '@sapphire/utilities';
import { envParseString } from '@skyra/env-utilities';
import { Command, RegisterCommand, RestrictGuildIds, type AutocompleteInteractionArguments, type TransformedArguments } from '@skyra/http-framework';
import type { APIApplicationCommandOptionChoice } from 'discord-api-types/v10';
import he from 'he';
import { URLSearchParams } from 'node:url';

@RegisterCommand((builder) =>
	builder //
		.setName('discordjs-guide')
		.setDescription('Search discord.js guides')
		.addStringOption((builder) =>
			builder //
				.setName('query')
				.setDescription('The phrase to search for')
				.setAutocomplete(true)
				.setRequired(true)
		)
		.addUserOption((builder) =>
			builder //
				.setName('target')
				.setDescription('Who should I ping that should look at these results?')
		)
)
@RestrictGuildIds(getGuildIds())
export class UserCommand extends Command {
	#algoliaUrl = new URL(`https://${envParseString('DJS_GUIDE_ALGOLIA_APPLICATION_ID')}.algolia.net/1/indexes/discordjs/query`);
	#responseHeaderText = `${hyperlink('Discord.js Guide', hideLinkEmbed('https://discordjs.guide'))} results:`;

	public override async autocompleteRun(interaction: Command.AutocompleteInteraction, args: AutocompleteInteractionArguments<Args>) {
		if (args.focused !== 'query' || isNullishOrEmpty(args.query)) {
			return interaction.replyEmpty();
		}

		const algoliaResponse = await this.fetchApi(args.query);

		const redisInsertPromises: Promise<'OK'>[] = [];
		const results: APIApplicationCommandOptionChoice[] = [];

		for (const [index, hit] of algoliaResponse.hits.entries()) {
			const hierarchicalName = buildHierarchicalName(hit.hierarchy);

			if (hierarchicalName) {
				redisInsertPromises.push(
					this.container.redisClient.insertFor60Seconds<DocsearchHit>(RedisKeys.DiscordJsGuide, args.query, index.toString(), hit)
				);

				results.push({
					name: cutText(hierarchicalName, 100),
					value: `${RedisKeys.DiscordJsGuide}:${args.query}:${index}`
				});
			}
		}

		if (redisInsertPromises.length) {
			await Promise.all(redisInsertPromises);
		}

		return interaction.reply({
			choices: results.slice(0, 19)
		});
	}

	public override async chatInputRun(interaction: Command.Interaction, { query, target }: Args) {
		const [, queryFromAutocomplete, nthResult] = query.split(':');
		const hitFromRedisCache = await this.container.redisClient.fetch<DocsearchHit>(RedisKeys.DiscordJsGuide, queryFromAutocomplete, nthResult);

		if (hitFromRedisCache) {
			const hierarchicalName = buildHierarchicalName(hitFromRedisCache.hierarchy, true);

			if (hierarchicalName) {
				return interaction.reply({
					content: buildResponseContent({
						content: hyperlink(hierarchicalName, hideLinkEmbed(hitFromRedisCache.url)),
						target: target?.user.id,
						headerText: this.#responseHeaderText,
						icon: DjsGuideIcon
					})
				});
			}
		}

		const algoliaResponse = await this.fetchApi(queryFromAutocomplete, 5);

		if (!algoliaResponse.hits.length) {
			return interaction.reply(
				errorResponse({
					content: `no results were found for ${inlineCode(queryFromAutocomplete)}`,
					allowed_mentions: {
						users: target?.user.id ? [target?.user.id] : []
					}
				})
			);
		}

		const results = algoliaResponse.hits.map(({ hierarchy, url }) =>
			he.decode(
				`• ${hierarchy.lvl0 ?? hierarchy.lvl1 ?? ''}: ${hyperlink(
					`${hierarchy.lvl2 ?? hierarchy.lvl1 ?? 'click here'}`,
					hideLinkEmbed(url)
				)}${hierarchy.lvl3 ? ` - ${hierarchy.lvl3}` : ''}`
			)
		);

		return interaction.reply({
			content: buildResponseContent({
				content: results,
				target: target?.user.id,
				headerText: this.#responseHeaderText,
				icon: DjsGuideIcon
			}),
			allowed_mentions: {
				users: target?.user.id ? [target?.user.id] : []
			}
		});
	}

	private async fetchApi(query: string, hitsPerPage = 25) {
		return fetch<AlgoliaSearchResult<'docsearch'>>(
			this.#algoliaUrl,
			{
				method: FetchMethods.Post,
				body: JSON.stringify({
					params: new URLSearchParams({
						query,
						hitsPerPage: hitsPerPage.toString()
					}).toString()
				}),
				headers: {
					'Content-Type': 'application/json',
					'X-Algolia-API-Key': envParseString('DJS_GUIDE_ALGOLIA_APPLICATION_KEY'),
					'X-Algolia-Application-Id': envParseString('DJS_GUIDE_ALGOLIA_APPLICATION_ID'),
					'User-Agent': FetchUserAgent
				}
			},
			FetchResultTypes.JSON
		);
	}
}

interface Args {
	query: string;
	target?: TransformedArguments.User;
}
