const router = require('express').Router();
const cookieParser = require('cookie-parser');

router.use('/:id', cookieParser(process.env.COOKIE_SECRET));

const path = require('path');
const Joi = require('@hapi/joi');
const shortid = require('shortid');
const s = require('../server-logic');
const {playerIdFromRequest, newPlayerId, setPlayerId, TwoWayMap} = require('../persistent');

// Information host submits for game (name, stack, bb, sb)
router.route('/').post((req, res) => {
    //scheme to ensure valid username
    const schema = Joi.object({
        // username: Joi.string().alphanum().min(2).max(10)
        username: Joi.string().regex(/^\w+(?:\s+\w+)*$/).min(2).max(10),
        smallBlind: Joi.number().integer().min(0),
        bigBlind: Joi.number().integer().min(0),
        stack: Joi.number().integer().min(1)
    });
    if (process.env.DEBUG === 'true') {
        req.body.name = req.body.name || 'debugName';
    }
    const {
        error,
        value
    } = schema.validate({
        username: req.body.name,
        smallBlind: req.body.smallBlind,
        bigBlind: req.body.bigBlind,
        stack: req.body.stack
    });
    if (error) {
        res.status(422);
        let message = error.details[0].message;
        console.log(message);
        if (message.includes("fails to match the required pattern: /^\\w+(?:\\s+\\w+)*$/")){
            message = "\"username\" cannot have punctuation"
        }
        res.json({
            isValid: false,
            message: message
        });
    } else {
        let sid = shortid.generate();
        req.body.shortid = sid;
        req.body.isValid = true;
        res.json(req.body);
        console.log(`starting new table with id: ${sid}`);
        s.createNewTable(sid, req.body.smallBlind, req.body.bigBlind, req.body.name, req.body.stack, 6969);
        tableSocketMap.set(sid, new TwoWayMap());
    }
});


// maps sid -> (player ID (from cookie) -> socket ID (from socket.io session) and vice versa)
// TODO: delete sid from tSM when table finishes
const tableSocketMap = new Map();

router.route('/:id').get((req, res) => {
    let sid = req.params.id;
    let t = s.getTableById(sid);
    if (!t){
        res.status(404).render('pages/404');
    }
    let table = t.table;

    let playerId = playerIdFromRequest(req);

    console.log('playerIdFromRequest', playerId, 'is active', s.isActivePlayerId(sid, playerId));
    // isActivePlayerId is false if the player previously quit the game
    const isNewPlayer = (playerId === undefined) || !s.isActivePlayerId(sid, playerId);
    console.log('inp', isNewPlayer);
    if (isNewPlayer) {
        // Create new player ID and set it as a cookie in user's browser
        playerId = newPlayerId();
        setPlayerId(playerId, req, res);
    }

    // gets a players socket ID from playerId
    const getSocketId = (playerId) => {
        return tableSocketMap.get(sid).key(playerId);
    };

    res.render('pages/game', {
        bigBlind: table.bigBlind,
        smallBlind: table.smallBlind,
        rank: 'A',
        suit: 'S',
        action: false,
        actionSeat: s.getActionSeat(sid),
        dealer: s.getDealerSeat(sid),
        color: 'black',
        name: t.hostName,
        stack: t.hostStack,
        showCards: false,
        joinedGame: s.isActivePlayerId(sid, playerId),
        waiting: !s.gameInProgress(sid),
        pot: s.getPot(sid),
        roundName: s.getRoundName(sid),
    });

    const io = req.app.get('socketio');
    io.once('connection', function (socket) {
        console.log('socket id!:', socket.id, 'player id', playerId);
        
        tableSocketMap.get(sid).set(playerId, socket.id);

        // socket.on('disconnect', (reason) => {
        //     console.log('pid', playerId, 'disconnect reason', reason);
        //     io.removeAllListeners('connection');
        // });

        // make sure host has a socketid associate with name (first player to enter the game)
        if (s.getPlayerId(sid, t.hostName) == 6969) {
            s.updatePlayerId(sid, t.hostName, playerId);
            console.log(s.getPlayerId(sid, t.hostName));
        }
        console.log('a user connected at', socket.id, 'with player ID', playerId);

        //adds socket to room (actually a sick feature)
        socket.join(sid);
        if (s.getModId(sid) != null){
            io.sockets.to(getSocketId(s.getModId(sid))).emit('add-mod-abilities');
        }
        io.sockets.to(sid).emit('render-players', s.playersInfo(sid));
        // highlight cards of player in action seat and get available buttons for players
        renderActionSeatAndPlayerActions(sid);

        // chatroom features
        // send a message in the chatroom
        socket.on('chat', (data) => {
            io.to(sid).emit('chat', {
                handle: s.getPlayerById(sid, playerId),
                message: data.message
            });
        });

        // typing
        socket.on('typing', (pid) => {
            socket.broadcast.to(sid).emit('typing', s.getPlayerById(sid, pid));
        });

        if (!isNewPlayer && s.gameInProgress(sid)) {
            // TODO: get returning player in sync with hand.
            //  render his cards, etc.
            console.log(`syncing ${s.getPlayerById(sid, playerId)}`);
            let data = s.playersInfo(sid);
            io.sockets.to(getSocketId(playerId)).emit('sync-board', {
                street: s.getRoundName(sid),
                board: s.getDeal(sid),
                sound: true
            });
            // TODO: check if player is in game
            // render player's hand
            // TODO: this doesn't work
            for (let i = 0; i < data.length; i++) {
                if (data[i].playerid === playerId) {
                    io.to(getSocketId(`${playerId}`)).emit('render-hand', {
                        cards: s.getCardsByPlayerName(sid, data[i].playerName),
                        seat: data[i].seat
                    });
                }
            }

            // highlight cards of player in action seat and get available buttons for players
            renderActionSeatAndPlayerActions(sid);
            // Play sound for action seat player
            if (s.getPlayerId(sid, s.getNameByActionSeat(sid)) === playerId) {
                io.to(getSocketId(playerId)).emit('players-action-sound', {});
            }
        }

        socket.on('buy-in', (data) => {
            // console.log(data);
            s.buyin(sid, data.playerName, playerId, data.stack);
            io.sockets.to(sid).emit('buy-in', data);
            io.sockets.to(sid).emit('render-players', s.playersInfo(sid));
            // highlight cards of player in action seat and get available buttons for players
            renderActionSeatAndPlayerActions(sid);
        });

        socket.on('leave-game', (data) => {
            // check if mod is leaving the game
            let oldModId = playerId;
            let modLeavingGame = false;
            if (playerId == s.getModId(sid)) {
                modLeavingGame = true;
            }

            if (!s.gameInProgress(sid)){
                let playerName = s.getPlayerById(sid, playerId);
                let seat = s.getPlayerSeat(sid, playerName);
                s.removePlayer(sid, playerName);
                console.log(`${playerName} leaves game`);
                if (modLeavingGame) {
                    // transfer mod if mod left game
                    if (s.getModId(sid) != null){
                        io.sockets.to(getSocketId(s.getModId(sid))).emit('add-mod-abilities');
                    }
                    io.sockets.to(getSocketId(oldModId)).emit('remove-mod-abilities');
                }
                io.sockets.to(sid).emit('remove-out-players', {seat: seat});
                s.makeEmptySeats(sid);
                // highlight cards of player in action seat and get available buttons for players
                renderActionSeatAndPlayerActions(sid);
                console.log('waiting for more players to rejoin');
            } else {
                let playerName = s.getPlayerById(sid, playerId);
                let stack = s.getStack(sid, playerName);
                let seat = s.getPlayerSeat(sid, playerName);
                prev_round = s.getRoundName(sid);
                console.log(`${playerName} leaves game for ${stack}`);
                // fold player
                // note: dont actually fold him (just emit folding noise)
                // s.fold(sid, playerName);
                io.sockets.to(sid).emit('fold', {
                    username: playerName,
                    stack: s.getStack(sid, playerName),
                    pot: s.getPot(sid),
                    seat: s.getPlayerSeat(sid, playerName),
                    amount: data.amount
                });
                // update client's stack size
                io.sockets.to(sid).emit('update-stack', {
                    seat: s.getPlayerSeat(sid, playerName),
                    stack: s.getStack(sid, playerName)
                });
                // shift action to next player in hand
                if (s.actionOnAllInPlayer(sid)) {
                    console.log('ACTION ON ALL IN PLAYER 123');
                } else {
                    // highlight cards of player in action seat and get available buttons for players
                    renderActionSeatAndPlayerActions(sid);
                }
                s.removePlayer(sid, playerName);
                if (modLeavingGame){
                    // transfer mod if mod left game
                    if (s.getModId(sid) != null){
                        io.sockets.to(getSocketId(s.getModId(sid))).emit('add-mod-abilities');
                    }
                    io.sockets.to(getSocketId(oldModId)).emit('remove-mod-abilities');
                }
                io.sockets.emit('buy-out', {
                    playerName: playerName,
                    stack: stack,
                    seat: seat
                });
                setTimeout(() => {
                    // check if round has ended
                    check_round(prev_round);
                }, 250);
                setTimeout(() => {
                    // notify player its their action with sound
                    io.to(getSocketId(`${s.getPlayerId(sid, s.getNameByActionSeat(sid))}`)).emit('players-action-sound', {});
                }, 500);
            }
        });

        socket.on('start-game', (data) => {
            let playersInNextHand = 0;
            if (table.playersToAdd) playersInNextHand += table.playersToAdd.length;
            if (table.players) playersInNextHand += table.players.length;
            console.log(`players in next hand: ${playersInNextHand}`);
            if (playersInNextHand >= 2 && playersInNextHand <= 10) {
                s.startGame(sid);
                io.sockets.to(sid).emit('start-game', s.playersInfo(sid));
                begin_round();
            } else {
                console.log("waiting on players");
            }
        });

        /**
         * @param playerName
         * @param data Player's action Object
         * @return {number} Amount bet. -1 if action cannot be performed
         */
        function performAction(playerName, data) {
            if (data.amount < 0) {
                return -1;
            }
            let actualBetAmount = 0;
            if (data.action === 'bet') {
                actualBetAmount = s.bet(sid, playerName, data.amount);
            } else if (data.action === 'raise') {
                actualBetAmount = s.raise(sid, playerName, data.amount);
            } else if (data.action === 'call') {
                actualBetAmount = s.getMaxBet(sid);
                s.call(sid, playerName);
            } else if (data.action === 'fold') {
                actualBetAmount = 0;
                s.fold(sid, playerName);
            } else if (data.action === 'check') {
                let canPerformAction = s.check(sid, playerName);
                if (canPerformAction) {
                    actualBetAmount = 0;
                }
            }
            return actualBetAmount;
        }
        
        socket.on('action', (data) => {
            // console.log(`data:\n${JSON.stringify(data)}`);
            let playerName = s.getPlayerById(sid, playerId);
            if (!s.gameInProgress(sid)) {
                console.log('game hasn\'t started yet');
            } else if (s.getActionSeat(sid) === s.getPlayerSeat(sid, playerName)) {
                prev_round = s.getRoundName(sid);

                let actualBetAmount = performAction(playerName, data);
                let canPerformAction = actualBetAmount >= 0;

                if (canPerformAction) {
                    io.sockets.to(sid).emit(`${data.action}`, {
                        username: playerName,
                        stack: s.getStack(sid, playerName),
                        pot: s.getPot(sid),
                        seat: s.getPlayerSeat(sid, playerName),
                        amount: actualBetAmount
                    });
                    // update client's stack size
                    io.sockets.to(sid).emit('update-stack', {
                        seat: s.getPlayerSeat(sid, playerName),
                        stack: s.getStack(sid, playerName)
                    });
                    // shift action to next player in hand
                    if (s.actionOnAllInPlayer(sid)){
                        console.log('ACTION ON ALL IN PLAYER');
                    } else {
                        // highlight cards of player in action seat and get available buttons for players
                        renderActionSeatAndPlayerActions(sid);
                    }
                    setTimeout(()=>{
                        // check if round has ended
                        check_round(prev_round);
                    }, 250);
                    setTimeout(()=>{
                        // notify player its their action with sound
                        io.to(getSocketId(`${s.getPlayerId(sid, s.getNameByActionSeat(sid))}`)).emit('players-action-sound', {});
                    }, 500);
                } else {
                    console.log(`${playerName} cannot perform action in this situation!`);
                }
            } else {
                console.log(`not ${playerName}'s action`);
            }
        });
    });
    
    //checks if round has ended (reveals next card)
    let check_round = (prev_round) => {
        let table = s.getTableById(sid).table;
        let playerSeatsAllInBool = s.getAllIns(sid);
        // console.log(table);
        let data = s.checkwin(sid);
        // SHOWDOWN CASE
        if (s.getRoundName(sid) === 'showdown') {
            io.sockets.to(sid).emit('update-pot', {amount: s.getPot(sid)});
            winners = s.getWinners(sid);
            console.log('winners');
            console.log('LOSERS');
            let losers = s.getLosers(sid);
            io.sockets.to(sid).emit('showdown', winners);

            
            // console.log("ALL IN");
            // console.log(s.getTableById(sid).table);
            // start new round
            setTimeout(() => {
                // handle losers
                for (let i = 0; i < losers.length; i++){
                    let playerName = losers[i].playerName;
                    let seat = s.getPlayerSeat(sid, playerName);
                    console.log(`${playerName} leaves game for 0`);
                    let oldModId = s.getModId(sid);
                    s.removePlayer(sid, playerName);
                    if (oldModId != s.getModId(sid)){
                        if (s.getModId(sid) != null){
                            io.sockets.to(getSocketId(s.getModId(sid))).emit('add-mod-abilities');
                        }
                        io.sockets.to(getSocketId(oldModId)).emit('remove-mod-abilities');
                    }
                    io.sockets.emit('buy-out', {
                        playerName: playerName,
                        stack: 0,
                        seat: seat
                    });
                }
                // start new round
                startNextRoundOrWaitingForPlayers()
            }, (3000));
        } 
        // if everyone is all in before the hand is over and its the end of the round, turn over their cards and let them race
        else if (s.everyoneAllIn(sid) && prev_round !== s.getRoundName(sid)) {
            console.log("EVERYONE ALL IN BEFORE SHOWDOWN, TABLE THEM");
            let allInPlayerSeatsHands = [];
            for (let i = 0; i < playerSeatsAllInBool.length; i++){
                if (playerSeatsAllInBool[i]){
                    allInPlayerSeatsHands.push({
                        seat: i,
                        cards: s.getCardsByPlayerName(sid, s.getPlayerBySeat(sid, i))
                    });
                }
            }
            // NEED TO ADD NON ALL IN PLAYER WHO CALLED HERE AS WELL (will do later)
            io.sockets.to(sid).emit('turn-cards-all-in', allInPlayerSeatsHands);
            io.sockets.to(sid).emit('update-pot', {
                amount: s.getPot(sid)
            });

            let rName = prev_round;
            while (s.getRoundName(sid) !== 'showdown'){
                console.log(rName);
                if (rName !== s.getRoundName(sid)){
                    rName = s.getRoundName(sid);
                        io.sockets.to(sid).emit('render-board', {
                            street: s.getRoundName(sid),
                            board: s.getDeal(sid),
                            sound: true
                        });
                }
                s.call(sid, s.getNameByActionSeat(sid));
            }
            check_round('showdown');
        } else if (data.everyoneFolded) {
            console.log(prev_round);
            // POTENTIALLY SEE IF prev_round can be replaced with s.getRoundName
            let winnings = s.getWinnings(sid, prev_round);
            // console.log(data.winner);
            console.log(`${data.winner.playerName} won a pot of ${winnings}`);

            // tell clients who won the pot
            io.sockets.to(sid).emit('folds-through', {
                username: data.winner.playerName,
                amount: winnings,
                seat: s.getPlayerSeat(sid, data.winner.playerName)
            });

            // start new round
            setTimeout(() => {
                // update client's stack size
                io.sockets.to(sid).emit('update-stack', {
                    seat: s.getPlayerSeat(sid, data.winner.playerName),
                    stack: data.winner.chips + winnings
                });

                // update stack on the server
                console.log(`Player has ${s.getStack(sid, data.winner.playerName)}`);
                console.log('Updating player\'s stack on the server...');
                s.updateStack(sid, data.winner.playerName, winnings);
                console.log(`Player now has ${s.getStack(sid, data.winner.playerName)}`)

                // next round
                startNextRoundOrWaitingForPlayers();
                
            }, (3000));
        } else if (prev_round !== s.getRoundName(sid)) {
            // console.log("ALL IN");
            // console.log(s.getTableById(sid).table);
            io.sockets.to(sid).emit('update-pot', {amount: s.getPot(sid)});
            io.sockets.to(sid).emit('render-board', {
                street: s.getRoundName(sid),
                board: s.getDeal(sid),
                sound: true
            });
        }
    }

    let startNextRoundOrWaitingForPlayers = () => {
        // start new round
            s.startRound(sid);
            if (s.gameInProgress(sid)) {
                begin_round();
            } else {
                io.sockets.to(sid).emit('waiting', {});
                s.makeEmptySeats(sid);
                io.sockets.to(sid).emit('remove-out-players', {});
                io.sockets.to(sid).emit('render-board', {street: 'deal', sound: false});
                io.sockets.to(sid).emit('new-dealer', {seat: -1});
                io.sockets.to(sid).emit('update-pot', {amount: 0});
                io.sockets.to(sid).emit('clear-earnings', {});
                io.sockets.to(sid).emit('available-actions', {availableActions: s.getAvailableActions(sid)});
                console.log('waiting for more players to rejoin!');
            }
    }

    let begin_round = () => {
        io.sockets.to(sid).emit('render-board', {street: 'deal', sound: true});
        s.makeEmptySeats(sid);
        io.sockets.to(sid).emit('remove-out-players', {});
        io.sockets.to(sid).emit('new-dealer', {seat: s.getDealerSeat(sid)});
        io.sockets.to(sid).emit('nobody-waiting', {});
        io.sockets.to(sid).emit('update-pot', {amount: 0});
        io.sockets.to(sid).emit('clear-earnings', {});
        // io.sockets.to(sid).emit('hide-hands', {});
        io.sockets.to(sid).emit('initial-bets', {seats: s.getInitialBets(sid)});
        let data = s.playersInfo(sid);
        console.log('d', data);
        for (let i = 0; i < data.length; i++) {
            let name = data[i].playerName;
            io.to(getSocketId(`${data[i].playerid}`)).emit('render-hand', {
                cards: s.getCardsByPlayerName(sid, name),
                seat: data[i].seat
            });
            io.sockets.to(sid).emit('update-stack', {
                seat: data[i].seat,
                stack: data[i].stack
            });

        }
        // highlight cards of player in action seat and get available buttons for players
        renderActionSeatAndPlayerActions(sid);
        // abstracting this to be able to work with bomb pots/straddles down the line
        io.to(getSocketId(s.getPlayerId(sid, s.getNameByActionSeat(sid)))).emit('players-action-sound', {});
    }

    let renderActionSeatAndPlayerActions = (sid) => {
        // highlight cards of player in action seat
        io.sockets.to(sid).emit('action', {
            seat: s.getActionSeat(sid)
        });
        // get available actions for player to act
        // TODO: iterate over every player in sid and emit actions (for premoves, etc)
        let playerIds = s.getPlayerIds(sid);
        for (let i = 0; i < playerIds.length; i++){
            let pid = playerIds[i];
            // console.log(s.getAvailableActions(sid, actionPlayerId));
            io.to(getSocketId(`${pid}`)).emit('render-action-buttons', {
                availableActions: s.getAvailableActions(sid, pid)
            });
        }
    }
});

module.exports = router;