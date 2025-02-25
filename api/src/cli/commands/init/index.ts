import chalk from 'chalk';
import execa from 'execa';
import inquirer from 'inquirer';
import Joi from 'joi';
import type { Knex } from 'knex';
import ora from 'ora';
import { v4 as uuid } from 'uuid';
import runMigrations from '../../../database/migrations/run';
import runSeed from '../../../database/seeds/run';
import { generateHash } from '../../../utils/generate-hash';
import createDBConnection, { Credentials } from '../../utils/create-db-connection';
import createEnv from '../../utils/create-env';
import { defaultAdminRole, defaultAdminUser } from '../../utils/defaults';
import { drivers, getDriverForClient } from '../../utils/drivers';
import { databaseQuestions } from './questions';

export default async function init(): Promise<void> {
	const rootPath = process.cwd();

	const { client } = await inquirer.prompt([
		{
			type: 'list',
			name: 'client',
			message: 'Choose your database client',
			choices: Object.values(drivers),
		},
	]);

	const dbClient = getDriverForClient(client)!;

	const spinnerDriver = ora('Installing Database Driver...').start();
	await execa('npm', ['install', dbClient, '--production']);
	spinnerDriver.stop();

	let attemptsRemaining = 5;

	const { credentials, db } = await trySeed();

	async function trySeed(): Promise<{ credentials: Credentials; db: Knex }> {
		const credentials: Credentials = await inquirer.prompt(
			(databaseQuestions[dbClient] as any[]).map((question: ({ client, filepath }: any) => any) =>
				question({ client: dbClient, filepath: rootPath })
			)
		);

		const db = createDBConnection(dbClient, credentials!);

		try {
			await runSeed(db);
			await runMigrations(db, 'latest', false);
		} catch (err: any) {
			process.stdout.write('\nSomething went wrong while seeding the database:\n');
			process.stdout.write(`\n${chalk.red(`[${err.code || 'Error'}]`)} ${err.message}\n`);
			process.stdout.write('\nPlease try again\n\n');

			attemptsRemaining--;

			if (attemptsRemaining > 0) {
				return await trySeed();
			} else {
				process.stdout.write("Couldn't seed the database. Exiting.\n");
				process.exit(1);
			}
		}

		return { credentials, db };
	}

	await createEnv(dbClient, credentials!, rootPath);

	process.stdout.write('\nCreate your first admin user:\n\n');

	const firstUser = await inquirer.prompt([
		{
			type: 'input',
			name: 'email',
			message: 'Email',
			default: 'admin@example.com',
			validate: (input: string) => {
				const emailSchema = Joi.string().email().required();
				const { error } = emailSchema.validate(input);
				if (error) throw new Error('The email entered is not a valid email address!');
				return true;
			},
		},
		{
			type: 'password',
			name: 'password',
			message: 'Password',
			mask: '*',
			validate: (input: string | null) => {
				if (input === null || input === '') throw new Error('The password cannot be empty!');
				return true;
			},
		},
	]);

	firstUser.password = await generateHash(firstUser.password);

	const userID = uuid();
	const roleID = uuid();

	await db('directus_roles').insert({
		id: roleID,
		...defaultAdminRole,
	});

	await db('directus_users').insert({
		id: userID,
		email: firstUser.email,
		password: firstUser.password,
		role: roleID,
		...defaultAdminUser,
	});

	await db.destroy();

	process.stdout.write(`\nYour project has been created at ${chalk.green(rootPath)}.\n`);
	process.stdout.write(`\nThe configuration can be found in ${chalk.green(rootPath + '/.env')}\n`);
	process.stdout.write(`\nStart Directus by running:\n`);
	process.stdout.write(`  ${chalk.blue('cd')} ${rootPath}\n`);
	process.stdout.write(`  ${chalk.blue('npx directus')} start\n`);

	process.exit(0);
}
