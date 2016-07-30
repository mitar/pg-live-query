const PGUIDs       = require('./pguids');
const EventEmitter = require('events');
const helpers      = require('./helpers');

const EVENTS = {
	1 : 'insert',
	2 : 'update',
	3 : 'delete'
};

// A counter for naming query tables
let ctr = 0;

// A queue for re-running queries
const queue = [];

// Keep track of which tables we've added triggers to
const triggers = {};

class Watcher {
	constructor(client, uid_col, rev_col) {
		this.uid_col = uid_col || '__id__';
		this.rev_col = rev_col || '__rev__';
		this.uid     = new PGUIDs(client, this.uid_col, this.rev_col);
		this.client  = client;

		this.client.query('LISTEN __qw__');

		this.client.on('notification', (message) => {
			const key = message.payload;

			queue.forEach((item) => {
				item.tables[key] && ++item.stale;
			});

			this.process();
		});
	}

	// Get the selected columns from a sql statement
	cols(sql) {
		const meta = [
			this.uid_col,
			this.rev_col
		];

		const cols_sql = `
			SELECT
				*
			FROM
				(${sql}) q
			WHERE
				0 = 1
		`;

		return new Promise((resolve, reject) => {
			this.client.query(cols_sql, (error, result) => {
				if(error) {
					reject(error);
				}
				else {
					const cols = result.fields
						.filter(({ name }) => meta.indexOf(name) === -1)
						.map(({ name }) => name);

					resolve(cols);
				}
			});
		});
	}

	// Initialize a temporary table to keep track of state changes
	initializeQuery(sql) {
		return new Promise((resolve, reject) => {
			const table   = `__qw__${ctr++}`;
			const i_table = helpers.quote(table);

			// Create a table to keep track of state changes
			const table_sql = `
				CREATE TEMP TABLE ${i_table} (
					id TEXT NOT NULL PRIMARY KEY,
					rev BIGINT NOT NULL
				)
			`;

			this.cols(sql).then((cols) => {
				this.client.query(table_sql, (error, result) => {
					error ? reject(error) : resolve([ table, cols ]);
				});
			});
		});
	}

	// Create some triggers
	createTriggers(tables) {
		const promises = [];

		for(const i in tables) {
			if(triggers[i]) {
				promises.push(triggers[i]);
				continue;
			}

			const i_table   = helpers.tableRef(tables[i]);
			const i_trigger = helpers.quote(`__qw__${i}`);
			const l_key     = helpers.quote(i, true);

			const drop_sql = `
				DROP TRIGGER IF EXISTS
					${i_trigger}
				ON
					${i_table}
			`;

			const func_sql = `
				CREATE OR REPLACE FUNCTION pg_temp.${i_trigger}()
				RETURNS TRIGGER AS $$
					BEGIN
						EXECUTE pg_notify('__qw__', '${l_key}');
					RETURN NULL;
					END;
				$$ LANGUAGE plpgsql
			`;

			const create_sql = `
				CREATE TRIGGER
					${i_trigger}
				AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON
					${i_table}
				EXECUTE PROCEDURE pg_temp.${i_trigger}()
			`;

			triggers[i] = new Promise((resolve, reject) => {
				this.client.query(drop_sql, (error, result) => {
					if(error) {
						reject(error);
					}
					else {
						this.client.query(func_sql, (error, result) => {
							if(error) {
								reject(error);
							}
							else {
								this.client.query(create_sql, (error, result) => {
									error ? reject(error) : resolve(result);
								});
							}
						});
					}
				});
			});

			promises.push(triggers[i]);
		}

		return Promise.all(promises);
	}

	// Process the queue
	process() {
		// Sort the queue to put the stalest queries first
		queue.sort((a, b) => b.stale - a.stale);

		// Get the stalest item
		const item = queue[0];

		// If there are no (stale) items do nothing
		if(!item || !item.stale) {
			return;
		}

		// This item is now fresh
		item.stale = 0;

		// Update the item, then process the next one
		item.update().then((changes) => {
			// Emit individual events and map the
			// change rows to a more sensible format
			changes = changes.map(({ c }) => {
				// Emit an event for this change
				item.handler.emit(EVENTS[c.op], c.id, c.data);

				return c;
			});

			// Emit a 'changes' event
			item.handler.emit('changes', changes, item.cols);
		}, (error) => {
			// Emit an 'error' event
			item.handler.emit('error', error);
		}).then(this.process);
	}

	// Watch for changes to query results
	watch(sql) {
		const handler = new EventEmitter();

		// Initialize the state change table
		const promise = this.initializeQuery(sql).then(([ table, cols ]) => {
			// Add the meta columns to this query
			return this.uid.addMetaColumns(sql).then(({ sql, tables}) => {
				// Watch the tables for changes
				return this.createTriggers(tables).then(() => {
					// Start tracking changes from the beginning
					let rev = 0;

					// Create an update function for this query
					const update = () => {
						return this.update(table, cols, sql, rev).then((rows) => {
							// Update the last revision
							const tmp_rev = rows
								.map((row) => row.__rev__)
								.reduce((p, c) => Math.max(p, c), 0);

							rev = Math.max(rev, tmp_rev);

							return rows;
						});
					};

					// Initialize the query as stale
					const stale = true;

					// Initial state
					const state = {};

					// Add this query to the queue
					queue.push({
						update,
						stale,
						tables,
						cols,
						handler,
						state
					});

					// Process the queue
					this.process();
				});
			});
		});

		promise.then(() => {
			handler.emit('ready');
		}, (error) => {
			handler.emit('error', error);
		});

		return handler;
	}

	// Update query state
	update(table, cols, sql, last_rev) {
		last_rev = last_rev || 0;

		const i_table   = helpers.quote(table);
		const i_uid     = helpers.quote(this.uid.output.uid);
		const i_rev     = helpers.quote(this.uid.output.rev);
		const i_seq     = helpers.quote(this.uid.output.seq);
		const i_uid_out = helpers.quote(this.uid_col);
		const i_rn_out  = helpers.quote('~~~rn~~~');
		const i_cols    = cols.map((col) => `q.${helpers.quote(col)}`).join(',');

		const update_sql = `
			WITH
				q AS (
					SELECT
						*,
						ROW_NUMBER() OVER() AS ${i_rn_out}
					FROM
						(${sql}) t
				),
				u AS (
					UPDATE ${i_table} SET
						rev = q.${i_rev}
					FROM
						q
					WHERE
						${i_table}.id = q.${i_uid} AND
						${i_table}.rev < q.${i_rev}
					RETURNING
						${i_table}.id,
						${i_table}.rev
				),
				d AS (
					DELETE FROM
						${i_table}
					WHERE
						NOT EXISTS(
							SELECT
								1
							FROM
								q
							WHERE
								q.${i_uid} = ${i_table}.id
						)
					RETURNING
						${i_table}.id,
						nextval('${i_seq}') AS rev
				),
				i AS (
					INSERT INTO ${i_table} (
						id,
						rev
					)
					SELECT
						${i_uid},
						${i_rev}
					FROM
						q
					WHERE
						q.${i_rev} > $1 AND
						q.${i_uid} NOT IN (select id FROM u) AND
						NOT EXISTS(
							SELECT
								1
							FROM
								${i_table} WHERE id = q.${i_uid}
						)
					RETURNING
						${i_table}.id,
						${i_table}.rev
				)
			SELECT
				jsonb_build_object(
					'id', md5(i.id),
					'op', 1, -- INSERT
					'rn', q.${i_rn_out},
					'data', jsonb_build_array(${i_cols})
				) AS c
			FROM
				i JOIN
				q ON
					i.id = q.${i_uid}

			UNION ALL

			SELECT
				jsonb_build_object(
					'id', md5(u.id),
					'op', 2, -- UPDATE
					'rn', q.${i_rn_out},
					'data', jsonb_build_array(${i_cols})
				) AS c
			FROM
				u JOIN
				q ON
					u.id = q.${i_uid}

			UNION ALL

			SELECT
				jsonb_build_object(
					'id', md5(d.id),
					'op', 3 -- DELETE
				) AS c
			FROM
				d
		`;

		const update_query = {
			name : `__qw__${table}`,
			text : update_sql
		};

		const params = [
			last_rev
		];

		return new Promise((resolve, reject) => {
			this.client.query(update_query, params, (error, result) => {
				error ? reject(error) : resolve(result.rows);
			});
		});
	}
}

module.exports = Watcher;