var events = require('events');
const {fillDeck, rankHandInt, rankHand} = require('./deck');

//Note: methods I've changed/created have been commented: EDITED

// straddleLimit values:
// -1: unlimited straddles (last player who can straddle is the dealer)
// 0: no straddling allowed
// 1: only player after big blind can straddle
// 1 < x <= players.length - 2: x players can straddle. if x == players.length -2,
//      the same behavior as -1 occurs.
// x > players.length - 2: same behavior as -1 occurs.
class Table {
    constructor(smallBlind, bigBlind, minPlayers, maxPlayers, minBuyIn, maxBuyIn, straddleLimit) {
        this.smallBlind = smallBlind;
        this.bigBlind = bigBlind;
        this.minPlayers = minPlayers;
        this.maxPlayers =  maxPlayers;
        // allPlayers[i].seat === i. empty seats correspond to a null element.
        this.allPlayers = [];
        for (let i = 0; i < maxPlayers; i++) {
            this.allPlayers.push(null);
        }
        this.dealer = 0; //Track the dealer position between games
        this.currentPlayer = -1; // Initialized to 1 in initializeBlinds (called by startGame)
        this.minBuyIn = minBuyIn;
        this.maxBuyIn = maxBuyIn;
        this.eventEmitter = new events.EventEmitter();
        this.gameWinners = [];
        this.gameLosers = [];
        this.straddleLimit = straddleLimit;
        this.game = null;

        //Validate acceptable value ranges.
        let err;
        if (minPlayers < 2) { //require at least two players to start a game.
            err = new Error(101, 'Parameter [minPlayers] must be a postive integer of a minimum value of 2.');
        } else if (maxPlayers > 10) { //hard limit of 10 players at a table.
            err = new Error(102, 'Parameter [maxPlayers] must be a positive integer less than or equal to 10.');
        } else if (minPlayers > maxPlayers) { //Without this we can never start a game!
            err = new Error(103, 'Parameter [minPlayers] must be less than or equal to [maxPlayers].');
        }

        if (err) {
            return err;
        }
    }

    get players() {
        return this.allPlayers.filter(p => p !== null && p.inHand);
    }

    get waitingPlayers() {
        return this.allPlayers.filter(p => p!== null && !p.inHand && !p.leavingGame);
    }

    get leavingPlayers() {
        return this.allPlayers.filter(p => p !== null && p.leavingGame)
    }

    getHandForPlayerName( playerName ){
        const p = this.getPlayer(playerName);
        if (p !== null) return p.cards;
        return [];
    };

    getPlayer( playerName ){
        const i = this.allPlayers.findIndex(elem => elem !== null && elem.playerName === playerName);
        if (i >= 0) return this.allPlayers[i];
        return null;
    };
    getDeal(){
        return this.game.board;
    };
    getEventEmitter() {
        return this.eventEmitter;
    };
    getCurrentPlayer() {
        return this.players[ this.currentPlayer ].playerName;
    };

    /**
     * Calculates the maximum that a player can bet (total) as limited
     * by his going all in or making everyone else at the table go all in
     * if he has the biggest stack
     * @param playerInd Index of player in this.players
     */
    maxBetPossible(playerInd) {
        const otherPlayersMaxStack = maxSkippingIndices(this.players.map(x => x.bet + x.chips), playerInd);
        return Math.min(this.players[playerInd].bet + this.players[playerInd].chips);
    };

    callBlind(playerName) {
        let currentPlayer = this.currentPlayer;
        const p = this.players[this.currentPlayer];
        if ( playerName !== p.playerName ) {
            console.log("wrong user has made a move");
            return -1;
        }
        console.log(`${playerName} calls blind`);

        const maxBet = this.getMaxBet();
        const bigBlindIndex = (this.dealer + 2) % this.players.length;
        const isBigBlind = currentPlayer === bigBlindIndex;
        let callAmount;
        if (isBigBlind || maxBet >= this.bigBlind) {
            callAmount = Math.min(p.chips + p.bet, maxBet) - p.bet;
        } else {
            const otherPlayersMaxStack = maxSkippingIndices(this.players.map(x => x.bet + x.chips), currentPlayer);
            // bet bigBlind if following players have a stack >= bigBlind
            // bet < bigBlind if no other player has a stack >= bigBlind
            callAmount = Math.min(otherPlayersMaxStack, this.bigBlind, p.bet + p.chips) - p.bet;
        }
        p.Bet(callAmount);
        progress(this);
        return callAmount;
    };

    // Player actions: Check(), Fold(), Bet(bet), Call(), AllIn()
    check( playerName ){
        const currentPlayer = this.currentPlayer;
        //   EDITED (primarily to deal with 'checking' to close action as bb)
        let cancheck = true;

        for (let v = 0; v < this.players.length; v++) {
            //essentially wrapping this check as a call
            if (this.game.roundName === 'deal' && this.players[v].bet === this.bigBlind && currentPlayer === v){
                if (playerName === this.players[currentPlayer].playerName) {
                    this.players[currentPlayer].Bet(0);
                    progress(this);
                    return true;
                } else {
                    console.log("wrong user has made a move 1234");
                    return false;
                }
            } else if (this.players[v].bet !== 0) {
                cancheck = false;
            }
        }
        if( playerName === this.players[ currentPlayer ].playerName){
            console.log('here!');
            if (cancheck){
                this.players[currentPlayer].Check();
                progress(this);
                console.log(`${playerName} checks`);
                progress(this);
                return true;
            } else {
                console.log(`${playerName} unable to check`);
                return false;
            }
        } else {
            // todo: check if something went wrong ( not enough money or things )
            console.log("wrong user has made a move abcd");
            return false;
        }
    };
    fold( playerName ){
        let p = this.players[this.currentPlayer];
        if( playerName === p.playerName ){
            this.game.pot += p.bet;
            p.Fold();
            progress(this);
            console.log(`${playerName} folds`);
            return true;
        }else{
            console.log("wrong user has made a move");
            return false;
        }
    };
    call( playerName ){
        let p = this.players[this.currentPlayer];
        if( playerName === p.playerName ) {
            const maxBet = this.getMaxBet();
            console.log(`${playerName} calls`);
            if (p.chips > maxBet) {
                console.log(`${playerName} calls`);
                // treat call as bet
                const betAmount = p.Bet(maxBet - p.bet);
                progress(this);
                return betAmount;
            } else {
                console.log(`${playerName} doesn't have enough to call, going all in.`);
                const betAmount = p.AllIn();
                progress(this);
                return betAmount;
            }
        }else{
            console.log("wrong user has made a move");
            return -1;
        }
    };

    /**
     * @param playerName Player betting
     * @param amt Amount to bet (on top of current bet)
     * @return {number|*} Actual amount bet. 0 < y <= amt if player goes all in. y =-1 if amt < 0 or it is not user's turn.
     */
    bet( playerName, amt ){
        if (amt < 0) {
            console.log(`${playerName} tried to bet ${amt}`);
            return -1;
        }
        if( playerName !== this.players[ this.currentPlayer ].playerName ) {
            console.log("wrong user has made a move");
            return -1;
        }
        console.log(`${playerName} bet ${amt}`);
        const betAmount = this.players[ this.currentPlayer ].Bet( amt );
        progress(this);
        return betAmount;
    };

    getWinners(){
        return this.gameWinners;
    };
    getLosers(){
        return this.gameLosers;
    };
    getAllHands(){
        var all = this.losers.concat( this.players );
        var allHands = [];
        for( var i in all ){
            allHands.push({
                playerName: all[i].playerName,
                chips: all[i].chips,
                hand: all[i].cards,
            });
        }
        return allHands;
    };

    initNewRound () {
        this.removeAndAddPlayers();
        if (this.players.length < 2) {
            console.log('not enough players (initNewRound)');
            this.game = null;
            return;
        }
        this.dealer = (this.dealer + 1) % this.players.length;
        this.game.pot = 0;
        this.game.roundName = 'deal'; //Start the first round
        this.game.betName = 'bet'; //bet,raise,re-raise,cap
        this.game.deck.splice(0, this.game.deck.length);
        this.game.board.splice(0, this.game.board.length);
        for (let i = 0; i < this.players.length; i += 1) {
            this.players[i].inHand = true;
            this.players[i].bet = 0;
            this.players[i].folded = false;
            this.players[i].talked = false;
            this.players[i].allIn = false;
            this.players[i].cards.splice(0, this.players[i].cards.length);
        }
        fillDeck(this.game.deck);
        this.NewRound();
    };

    canStartGame () {
        // return this.playersToAdd && this.playersToAdd.length >= 2 && this.playersToAdd.length <= 10;
        // console.log(this.playersToAdd);
        // return (!this.game && this.players.length >= 2 && this.players.length <= 10);
        return true;
    }

    StartGame () {
        //If there is no current game and we have enough players, start a new game.
        if (!this.game) {
            this.game = new Game(this.smallBlind, this.bigBlind);
            this.NewRound();
        }
    };
    AddPlayer(playerName, chips, isStraddling) {
        // console.log(`adding player ${playerName}`);
        // Check if playerName already exists
        const ind = this.allPlayers.findIndex(p => p !== null && p.playerName === playerName);
        if (ind !== -1) {
            const p = this.allPlayers[ind];
            if (p.leavingGame) {
                p.leavingGame = false;
                p.chips = chips;
                p.isStraddling = isStraddling;
                return true;
            }
        } else {
            const seat = this.getAvailableSeat();
            if ( chips >= this.minBuyIn && chips <= this.maxBuyIn && seat !== -1) {
                const player = new Player(playerName, chips, isStraddling, seat);
                this.allPlayers[seat] = player;
                return true;
            }
        }
        return false;
    };
    getAvailableSeat() {
        return this.allPlayers.findIndex(elem => elem === null || elem.leavingGame);
    };
    getMaxBet() {
        return Math.max(...this.players.map(x => x.bet));
    };
    removePlayer (playerName){
        const ind = this.allPlayers.findIndex(p => p !== null && p.playerName === playerName);
        if (ind === -1) return false;
        // this.playersToRemove.push(ind);

        const p = this.allPlayers[ind];
        this.allPlayers[p.seat].leavingGame = true;
        if (this.game != null) {
            this.game.pot += p.bet;
            // this.allPlayers[ind] = null;
            p.Fold();
            progress(this);
        }
        return true;
    }

    removeAndAddPlayers() {
        const playersToRemove = this.leavingPlayers;
        const playersToAdd = this.waitingPlayers;

        for (const p of playersToRemove) {
            if (p.seat <= this.dealer)
                this.dealer--;
            this.allPlayers[p.seat] = null;
        }
        for (const p of playersToAdd) {
            if (p.seat <= this.dealer)
                this.dealer++;
            p.inHand = true;
        }
        if (this.players.length >= 2) {
            this.dealer = this.dealer % this.players.length;
        } else {
            this.dealer = 0;
        }
    }

    NewRound() {
        this.removeAndAddPlayers();
        // EDITED
        if (this.players.length < 2){
            console.log('not enough players (NewRound)');
            this.game = null;
            return;
        }
        this.gameWinners = [];
        this.gameLosers = [];

        //Deal 2 cards to each player
        for (let i = 0; i < this.players.length; i += 1) {
            this.players[i].cards.push(this.game.deck.pop());
            this.players[i].cards.push(this.game.deck.pop());
            this.players[i].bet = 0;
            this.game.roundBets[i] = 0;
        }
        this.initializeBlinds();

        this.eventEmitter.emit( "newRound" );
    };

    // straddleLimit values:
    // -1: unlimited straddles (last player who can straddle is the dealer)
    // 0: no straddling allowed
    // 1: only player after big blind can straddle
    // 1 < x <= players.length - 2: x players can straddle. if x == players.length -2,
    //      the same behavior as -1 occurs.
    // x > players.length - 2: same behavior as -1 occurs.
    // Up to this.players.length -2 players can straddle because
    //      the last player that is able to is the dealer
    maxStraddles() {
        if (this.players.length <= 2) return 0;
        if (this.straddleLimit >= 0 && this.straddleLimit <= this.players.length -2) {
            return this.straddleLimit;
        }
        if (this.straddleLimit === -1 || this.straddleLimit > this.players.length -2) {
            return this.players.length - 2;
        }
        // straddleLimit < -1
        console.log(`Invalid straddleLimit value ${this.straddleLimit}`);
        return 0;
    };

    initializeBlinds() {
        // Small and Big Blind player indexes
        let smallBlind = (this.dealer + 1) % this.players.length;
        let bigBlind = (this.dealer + 2) % this.players.length;

        // Force Blind Bets
        this.currentPlayer = smallBlind;
        this.postBlind(this.smallBlind);
        this.currentPlayer = bigBlind;
        this.postBlind(this.bigBlind);

        const maxStraddles = this.maxStraddles();
        for (let i = 0; i < maxStraddles; i++) {
            const nextPlayer = (this.currentPlayer + 1) % this.players.length;
            if (!this.players[nextPlayer].isStraddling) { break; }
            const straddleAmount = this.bigBlind * Math.pow(2, i + 1); // bigBlind * 2^(i+1)
            if (this.players[nextPlayer].chips < straddleAmount) {
                console.log(`${this.players[nextPlayer]} does not have enough to straddle`);
                break;
            }
            this.currentPlayer = nextPlayer;
            this.postBlind(straddleAmount);
        }
        this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
    };

    postBlind(blindAmount) {
        const otherPlayersMaxStack = maxSkippingIndices(this.players.map(x => x.bet + x.chips), this.currentPlayer);
        const p = this.players[this.currentPlayer];
        console.log('t', this);
        let betAmount = Math.min(otherPlayersMaxStack, blindAmount, p.bet + p.chips);
        betAmount = p.Bet(betAmount);
        p.talked = false;
        return betAmount;
    };

    checkwin() {
        let numPlayers = 0;
        let pwinner;
        for (let i = 0; i < this.players.length; i++){
            if (!this.players[i].folded) {
                numPlayers++;
                pwinner = this.players[i];
            }
        }
        if (numPlayers === 1) {
            console.log("everyone's folded!");
            return {
                everyoneFolded: true,
                pot: this.game.pot,
                winner: pwinner
            };
        }
        return {
            everyoneFolded: false,
            pot: null,
            winner: null
        };
    };
}

class Player {
    /**
     * Constructs a Player object for use with Table.
     * @param playerName Name of the player as it should appear on the front end
     * @param chips The player's initial chip stack
     * @param isStraddling If the player wants to straddle
     * @constructor
     */
    constructor(playerName, chips, isStraddling, seat) {
        this.playerName = playerName;
        this.chips = chips;
        this.folded = false;
        this.allIn = false;
        this.talked = false;
        // If the player is in the current hand. False is they are standing up, have quit/ will be removed, or just joined.
        this.inHand = false;
        this.cards = [];
        this.bet = 0;
        this.isStraddling = isStraddling;
        this.seat = seat;
        this.leavingGame = false;
    }

    GetChips(cash) {
        this.chips += cash;
    };

    // Player actions: Check(), Fold(), Bet(bet), Call(), AllIn()
    Check() {
        this.applyBet(0);
        return 0;
    };

    Fold() {
        this.bet = 0;
        this.talked = true;
        this.folded = true;
        return 0;
    };

    applyBet(bet) {
        this.chips -= bet;
        this.bet += bet;
        this.talked = true;
        if (this.chips === 0) {
            this.allIn = true;
        }
    };

    // Returns amount bet. If this.chips < (parameter) bet, return value will be this.chips.
    /**
     * @param bet Amount to bet
     * @return {number|*} Amount actually bet.
     *          bet if player has enough chips. this.chips if player must go all in. -1 if bet is invalid (< 0).
     */
    Bet(bet) {
        if (bet < 0) {
            return -1;
        }
        if (this.chips > bet) {
            this.applyBet(bet);
            return bet;
        } else {
            console.log('You don\'t have enough chips --> ALL IN !!!');
            return this.AllIn();
        }
    };

    /**
     * @return {number} Amount bet
     */
    AllIn() {
        const allInValue = this.chips;
        this.applyBet(allInValue);
        return allInValue;
    };
}

function checkForEndOfRound(table) {
    let endOfRound = true;
    const maxBet = table.getMaxBet();
    //For each player, check
    // EDITED
    let counter = 1;
    let j = table.currentPlayer;
    while (counter <= table.players.length){
        const p = table.players[j];
        if (p.inHand && !p.folded && (!p.talked || p.bet !== maxBet) && !p.allIn) {
            table.currentPlayer = j;
            endOfRound = false;
            break;
        }
        j = (j + 1) % table.players.length;
        counter++;
    }
    return endOfRound;
}

function checkForAllInPlayer(table, winners) {
    var i, allInPlayer;
    allInPlayer = [];
    for (i = 0; i < winners.length; i += 1) {
        if (table.players[winners[i]].allIn === true) {
            allInPlayer.push(winners[i]);
        }
    }
    return allInPlayer;
}

function checkForWinner(table) {
    var i, j, k, l, maxRank, winners, part, prize, allInPlayer, minBets, roundEnd;
    //Identify winner(s)
    winners = [];
    maxRank = 0.000;
    for (k = 0; k < table.players.length; k += 1) {
        if (table.players[k].hand.rank === maxRank && table.players[k].folded === false) {
            winners.push(k);
        }
        if (table.players[k].hand.rank > maxRank && table.players[k].folded === false) {
            maxRank = table.players[k].hand.rank;
            winners.splice(0, winners.length);
            winners.push(k);
        }
    }

    part = 0;
    prize = 0;
    allInPlayer = checkForAllInPlayer(table, winners);
    if (allInPlayer.length > 0) {
        minBets = table.game.roundBets[winners[0]];
        for (j = 1; j < allInPlayer.length; j += 1) {
            if (table.game.roundBets[winners[j]] !== 0 && table.game.roundBets[winners[j]] < minBets) {
                minBets = table.game.roundBets[winners[j]];
            }
        }
        part = parseInt(minBets, 10);
    } else {
        part = parseInt(table.game.roundBets[winners[0]], 10);

    }
    for (l = 0; l < table.game.roundBets.length; l += 1) {
        if (table.game.roundBets[l] > part) {
            prize += part;
            table.game.roundBets[l] -= part;
        } else {
            prize += table.game.roundBets[l];
            table.game.roundBets[l] = 0;
        }
    }

    for (i = 0; i < winners.length; i += 1) {
        const winnerPrize = prize / winners.length;
        const winningPlayer = table.players[winners[i]];
        winningPlayer.chips += winnerPrize;
        if (table.game.roundBets[winners[i]] === 0) {
            winningPlayer.folded = true;
            table.gameWinners.push( {
                playerName: winningPlayer.playerName,
                amount: winnerPrize,
                hand: winningPlayer.hand,
                chips: winningPlayer.chips,
                seat: winningPlayer.seat,
            });
        }
        console.log('player ' + table.players[winners[i]].playerName + ' wins !!');
    }

    roundEnd = true;
    for (l = 0; l < table.game.roundBets.length; l += 1) {
        if (table.game.roundBets[l] !== 0) {
            roundEnd = false;
        }
    }
    if (roundEnd === false) {
        checkForWinner(table);
    }
}

function checkForBankrupt(table) {
    var i;
    for (i = 0; i < table.players.length; i += 1) {
        if (table.players[i].chips === 0) {
          table.gameLosers.push( table.players[i] );
            console.log('player ' + table.players[i].playerName + ' is going bankrupt');
            // EDIT
            // rather than removing players here i thin it makes sense to call remove player on it
            // table.players.splice(i, 1);
        }
    }
}

function Hand(cards) {
    this.cards = cards;
}

function progress(table) {
    table.eventEmitter.emit( "turn" );
    var i, j, cards, hand;
    if (table.game) {
        if (checkForEndOfRound(table) === true) {
          table.currentPlayer = (table.dealer + 1) % table.players.length;
          let ctr = 0;
          while(table.players[table.currentPlayer].folded && ctr < table.players.length){
              console.log('here 123:O');
              // basically we want to skip all of the folded players if they're folded when going to next round (currently sets to 0)
              table.currentPlayer = (table.currentPlayer + 1) % table.players.length;
              ctr++;
          }
          if (ctr >= table.players.length){
              console.log('giant massive error here please come back and check on logic this is a mess');
          }
          // ^^done with edits
            //Move all bets to the pot
            for (i = 0; i < table.players.length; i++) {
                table.game.pot += table.players[i].bet;
                table.game.roundBets[i] += table.players[i].bet;
            }
            if (table.game.roundName === 'River') {
                table.game.roundName = 'Showdown';
                // table.game.bets.splice(0, table.game.bets.length);
                //Evaluate each hand
                for (j = 0; j < table.players.length; j += 1) {
                    cards = table.players[j].cards.concat(table.game.board);
                    hand = new Hand(cards);
                    table.players[j].hand = rankHand(hand);
                }
                checkForWinner(table);
                checkForBankrupt(table);
                table.eventEmitter.emit( "gameOver" );
            } else if (table.game.roundName === 'Turn') {
                console.log('effective turn');
                table.game.roundName = 'River';
                turnCards(table, 1);
            } else if (table.game.roundName === 'Flop') {
                console.log('effective flop');
                table.game.roundName = 'Turn';
                turnCards(table, 1);
            } else if (table.game.roundName === 'deal') {
                console.log('effective deal');
                table.game.roundName = 'Flop';
                turnCards(table, 3);
            }
        }
    }
}

// count is the amount of cards to turn.for flop, should be 3. for turn and river, 1.
function turnCards(table, count) {
    table.game.deck.pop(); //Burn a card
    for (let i = 0; i < count; i += 1) { //Turn a card <count> times
        table.game.board.push(table.game.deck.pop());
    }
    for (let i = 0; i < table.players.length; i += 1) {
        table.players[i].talked = false;
        table.players[i].bet = 0;
    }
    table.eventEmitter.emit( "deal" );
}

function Game(smallBlind, bigBlind) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.pot = 0;
    this.roundName = 'deal'; //Start the first round
    this.betName = 'bet'; //bet,raise,re-raise,cap
    this.bets = [];
    this.roundBets = [];
    this.deck = [];
    this.board = [];
    fillDeck(this.deck);
}

/*
 * Helper Methods Public
 */

function maxSkippingIndices(arr, ...ind) {
    let m = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < arr.length; i++) {
        if (ind.includes(i)) continue;
        m = Math.max(m, arr[i])
    }
    return m;
}

function rankHands(hands) {
    var x, myResult;

    for (x = 0; x < hands.length; x += 1) {
        myResult = rankHandInt(hands[x]);
        hands[x].rank = myResult.rank;
        hands[x].message = myResult.message;
    }

    return hands;
}

module.exports.Table = Table;