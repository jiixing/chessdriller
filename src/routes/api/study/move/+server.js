import { json, error } from '@sveltejs/kit';
import { PrismaClient } from '@prisma/client';
import { moveIsDue } from '$lib/scheduler.js';

const prisma = new PrismaClient();

/*
 * learning step:
 *   0: new card, show immediately
 *   1: 1 min
 *   2: 10 min
 *   3: 8h
 *   4: 16h (move to review when done)
 */

const Max_Review_Interval = 100;

export async function POST({ request, locals }) {

	// session
	const { user } = await locals.auth.validateUser();
	if (!user) return json({ success: false, message: 'not logged in' });
	const userId = user.cdUserId;

	const { move_id, correct, guess, line_study_id } = await request.json();

	let interval_value = null;
	let interval_unit = null;
	let interval_increased = null; // interval can be increased from correctly guessing a due move, or from correctly guessing any move in review
	let interval_maxed = false;

	try {

	const move = await prisma.Move.findUniqueOrThrow({
		where: { id: move_id },
		select: {
			id: true,
			userId: true,
			ownMove: true,
			moveSan: true, // for debug only
			learningDueTime: true,
			learningStep: true,
			reviewDueDate: true,
			reviewInterval: true,
			reviewEase: true
		}
	}); // TODO return error message

	if ( move.userId != userId )
		throw new Error( "can't practice move belonging to another user ID" ); // TODO return error message
	if ( ! move.ownMove )
		throw new Error( "can't practice opponent's move" ); // TODO return error message

	// find next step

	const now = new Date(); 
	let update = {};
	if ( ! correct ) {
		// Incorrect: reset card, regardless of Learning/Review state.
		update.learningDueTime = new Date();
		update.learningStep = 0;
		update.reviewDueDate  = null;
		update.reviewInterval = null;
		update.reviewEase     = move.reviewEase ? Math.max( 1.3, move.reviewEase - 0.2 ) : null;
		interval_value = 0;
		interval_unit = 'm';
		interval_increased = false;
		console.log( 'move ' + move.moveSan + ' wrong' );
	} else {
		if ( move.learningDueTime ) {
			// promote correct moves in Learning regardless of whether they were due or not
			const step_minutes = [ 0, 1, 10, 8*60, 16*60 ]; // number of minutes' delay in each learning step
			if ( move.learningStep < 4 ) {
				update.learningStep = move.learningStep + 1;
				const minutes_delay = Math.ceil( fuzzed_minutes( step_minutes[update.learningStep], line_study_id ) );
				update.learningDueTime = datetime_in_n_minutes( minutes_delay );
				interval_value = minutes_delay;
				interval_unit = 'm';
				interval_increased = true;
			} else if ( move.learningStep == 4 ) {
				// graduate
				update.learningDueTime = null;
				update.learningStep    = null;
				update.reviewInterval  = 1;
				update.reviewDueDate   = date_in_n_days( update.reviewInterval );
				update.reviewEase      = move.reviewEase || 2.5;
				interval_value = update.reviewInterval;
				interval_unit = 'd';
				interval_increased = true;
			} else {
				throw new Error( 'invalid learning step for move '+move.id+': '+move.learningStep );
			}
		} else {
			// move in review
			if ( moveIsDue( move, now ) ) {
				update.reviewInterval = move.reviewInterval * move.reviewEase;
				if ( update.reviewInterval > Max_Review_Interval ) {
					update.reviewInterval = Max_Review_Interval;
					interval_maxed = true;
				}
				// Maybe reviewInterval should be fuzzed too? How does Anki do it?
				const fuzzed_interval = Math.ceil( fuzzed_days( update.reviewInterval, line_study_id ) );
				update.reviewDueDate  = date_in_n_days( fuzzed_interval );
				interval_value = fuzzed_interval;
				interval_unit = 'd';
				interval_increased = true;
			} else {
				// not due: don't increase interval
				const fuzzed_interval = Math.ceil( fuzzed_days(move.reviewInterval,line_study_id) );
				update.reviewDueDate  = date_in_n_days( fuzzed_interval );
				interval_value = fuzzed_interval;
				interval_unit = 'd';
				interval_increased = false;
			}
		}
		console.log( 'move ' + move.moveSan + ' correct, next due ' + ( update.learningDueTime || update.reviewDueDate ) );
	}

	await prisma.Move.update({
		where: { id: move.id },
		data: update
	});
	await prisma.StudyHistory.create({
		data: {
			userId: userId,
			moveId: move.id,
			incorrectGuessSan: correct ? null : guess
		}
	});


	} catch ( e ) {
		console.log(e);
		return json( {
			success: false,
			error: e.message
		} );
	}

	console.assert( interval_value !== null );
	console.assert( interval_unit !== null );
	console.assert( interval_increased !== null );
	return json( {
		success: true,
		interval: {
			value: interval_value, 
			unit: interval_unit,
			increased: interval_increased,
			maxed: interval_maxed
		}
	} );
}

function fuzzed_days( days_prefuzz, line_study_id ) {
	// expect line_study_id to be a random float [0,1)
	console.assert( line_study_id >= 0 && line_study_id < 1);
	if ( days_prefuzz < 2.5 ) {
		// lower interval than 2.5 days: no fuzz
		return days_prefuzz;
	}
	// fuzz by up to 1 day + 10% of interval in either direction
	const min_fuzz = - ( 1 + 0.1 * days_prefuzz );
	const max_fuzz =   ( 1 + 0.1 * days_prefuzz );
	const fuzz = min_fuzz + line_study_id * ( max_fuzz - min_fuzz ) ;
	return days_prefuzz + fuzz;
}

function fuzzed_minutes( minutes_prefuzz, line_study_id ) {
	console.assert( line_study_id >= 0 && line_study_id < 1);
	// just add 0-5 min (but don't increase by more than 100%)
	const fuzz = line_study_id * Math.min(5,minutes_prefuzz);
	return minutes_prefuzz + fuzz;
}

function datetime_in_n_minutes( n ) {
	let date = new Date();
	date.setTime( date.getTime() + n*60*1000 );
	return date;
}

function date_in_n_days( n ) {
	let date = new Date();
	date.setDate( date.getDate() + n );
	date.setUTCHours(0,0,0,0);
	return date;
}
