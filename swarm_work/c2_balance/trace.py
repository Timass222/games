"""Replay two deterministic funding scripts for the internal six-cycle demo."""

from pathlib import Path
from collections import Counter
import csv
import sys


TEAMS = ('A', 'K', 'B', 'J', 'M', 'O')
START = [(3, 3), (2, 3), (2, 4), (2, 2), (4, 2), (3, 2)]
BASE = [(1, 1, 3), (1, 1, 3), (1, 2, 4), (1, 1, 4), (2, 1, 3), (1, 1, 3)]
CARDS = {
    'P1': (1, 2, (1, 1, 2)), 'P2': (1, 2, (2, 0, 2)),
    'P3': (2, 2, (0, 2, 2)), 'P4': (2, 2, (1, 1, 2)),
    'P5': (1, 2, (2, 0, 2)), 'P6': (1, 2, (2, 1, 3)),
    'P7': (5, 2, (2, 1, 3)), 'P8': (5, 2, (1, 2, 3)),
    'P9': (6, 2, (1, 2, 3)), 'C1': (4, 2, (2, 1, 4)),
    'R1': (5, 1, (1, 1, 3)), 'R2': (2, 1, (1, 1, 2)),
    'R3': (1, 2, (1, 0, 2)), 'R4': (1, 2, (0, 1, 1)),
    'R5': (1, 1, (2, 1, 3)), 'T1': (1, 2, (2, 2, 6)),
    'T1X': (2, 1, (2, 1, 7)), 'T2': (4, 2, (3, 1, 7)),
    'O1': (1, 1, (1, 1, 2)), 'O2': (2, 1, (2, 1, 3)),
    'O3': (4, 1, (1, 2, 2)), 'O4': (5, 1, (1, 2, 3)),
    'O5': (4, 1, (2, 0, 3)),
}
SCORES = {
    'P1': (2, 0, 0, 0, 0), 'P2': (0, 3, 0, 0, 0), 'P3': (0, 0, 2, 0, 0),
    'P4': (0, 0, 0, 3, 0), 'P5': (0, 0, 0, 0, 2), 'P6': (1, 1, 1, 2, 1),
    'P7': (1, -1, 1, -2, 3), 'P8': (1, 3, 0, 2, -1), 'P9': (1, 0, 2, 0, 2),
    'O2': (0, 0, 0, 2, 0), 'O4': (0, 0, 0, 0, 2), 'O5': (0, 2, 0, 0, 0),
    'R1': (0, 0, 0, 1, 0),
}
PERSONAL = {'P1': 'A', 'P2': 'K', 'P3': 'B', 'P4': 'J', 'P5': 'M', 'O1': 'O', 'O3': 'O'}
REPRESENTATION = {'O2': 'J', 'O4': 'M', 'O5': 'K'}
DEADLINE = {'C1': 4, 'R1': 5, 'R2': 3, 'P9': 6}
EMPTY = (0, 0, 0)


# Each cycle gives transfers, then funded units. Triplets use wood/stone/work.
# Every allocation to a joint card is a current-cycle commitment by its participants.
SUCCESS = {
    1: ('MB100 BM010', 'T1:A112,B114 P2:K202 P6:J012,M201 R4:J011 P5:M202 O1:O112'),
    2: ('OK100 KO010', 'R2:K101,A011 T1:B214,A012 P6:M202,J011 O2:J002,O211 R4:J011 P2:K202'),
    3: ('', 'R3:B102 R3:A102 P4:J112 P5:M202'),
    4: ('', 'C1:A101,B013 C1:J013,M101 T2:A102,K003,B111,M101 O3:O122'),
    5: ('BJ010 JB100', 'T2:A112,K002,B204 P8:J123 P7:M213 O5:O102,K101'),
    6: ('', 'P7:M213 P8:K122,J001 P9:B123 P9:A123'),
}
COMPROMISE = {
    1: ('MB100 BM010', 'T1:A112,B114 P2:K202 P6:J012,M201 P5:M202 O1:O112'),
    2: ('', 'T1:B214,A012 P6:M202,J011 R5:O213 P2:K202 P4:J112'),
    3: ('', 'T1X:A113,B104 O2:J002,O211 P4:J112 P5:M202 R4:K011'),
    4: ('', 'C1:A102,J112 T2:B114,M203 O3:O122 R4:K011'),
    5: ('MB010 BM100', 'R1:A012,M101 O4:M001,O122 P8:K112,J011 P7:B012,M201'),
    6: ('MO020', 'P7:M202,O011 P8:K123 P9:B123 P9:A123'),
}
VOTE_SCORE = {'square': (1, 2, 0, -2, 1), 'compromise': (0, 0, 0, 0, 0)}


def change(values, amount, direction=1):
    for index, value in enumerate(amount):
        values[index] += direction * value


def decode(code):
    assert len(code) == 3
    return tuple(map(int, code))


def select_site(ballots):
    assert 1 <= len(ballots) <= 2
    for vote in ballots:
        assert len(vote) == len(TEAMS) and set(vote) <= set('SQRC')
        counts = Counter(vote)
        winner = next((site for site, count in counts.items() if count >= 4), None)
        if winner is not None:
            return {'S': 'square', 'Q': 'quarter', 'R': 'ruins', 'C': 'compromise'}[winner]
    assert len(ballots) == 2
    return 'compromise'


def replay(name, plan, ballots, repair=False):
    site = select_site(ballots)
    compromise = site == 'compromise'
    balances = {team: [*start, 0] for team, start in zip(TEAMS, START)}
    score = dict(zip(TEAMS, (*VOTE_SCORE[site], None)))
    paid = {card: [] for card in CARDS}
    complete = {}
    representatives = {}
    opposition = {}
    team_rows = []
    project_rows = []

    def capture(cycle, team, incoming=EMPTY, before=EMPTY, received=EMPTY, sent=EMPTY, used=EMPTY):
        record = [name, cycle, team]
        for part in (incoming, before, received, sent, used, balances[team]):
            record.extend(part)
        record.append(score[team] if team != 'O' else len(representatives))
        team_rows.append(record)

    for team in TEAMS:
        capture(0, team)

    for cycle, (transfers, actions) in plan.items():
        incoming = {team: list(resources) for team, resources in zip(TEAMS, BASE)}
        for resource_card, resource_index in [('R3', 1), ('R4', 0), ('R5', 2), ('O1', 1)]:
            if cycle - complete.get(resource_card, 100) in (1, 2):
                owners = set(owner for owner, in paid[resource_card])
                for owner in owners:
                    incoming[owner][resource_index] += 1

        is_flood = cycle >= 5 and 'C1' not in complete
        if is_flood and cycle == 5:
            for affected in 'AKJM':
                score[affected] -= 1
            for team, index in [('B', 1), ('J', 2), ('M', 0), ('O', 2)]:
                incoming[team][index] = max(0, incoming[team][index] - 1)
        if is_flood and cycle == 6 and 'R1' not in complete:
            incoming['M'][0] = max(0, incoming['M'][0] - 1)
        for team in representatives:
            transfer = min(1, incoming[team][2])
            incoming[team][2] -= transfer
            incoming['O'][2] += transfer

        for team in TEAMS:
            balances[team][2] = 0
            change(balances[team], incoming[team])
        before = {team: values.copy() for team, values in balances.items()}
        sent = {team: [0, 0, 0] for team in TEAMS}
        received = {team: [0, 0, 0] for team in TEAMS}
        spent = {team: [0, 0, 0] for team in TEAMS}

        for trade in transfers.split():
            source, target = trade[:2]
            amount = decode(trade[2:])
            assert source != target and sum(amount) > 0
            change(sent[source], amount)
            change(received[target], amount)
        for team in TEAMS:
            assert all(out <= have for out, have in zip(sent[team], before[team])), (name, cycle, team, 'reserve')
            change(balances[team], sent[team], -1)
            change(balances[team], received[team])

        ready_before = set(complete)

        for action in actions.split():
            card, raw_contributions = action.split(':')
            first_cycle, units, price = CARDS[card]
            assert cycle >= first_cycle and cycle <= DEADLINE.get(card, 6), (name, cycle, card, 'date')
            assert len(paid[card]) < units, (name, cycle, card, 'already complete')
            if card == 'T1X':
                assert compromise and 'T1' in ready_before
            if card == 'T2':
                assert ('T1X' if compromise else 'T1') in ready_before
            if card in ('R1', 'O4'):
                assert is_flood
            if card == 'C1' and 'R2' in ready_before:
                price = (1, 1, 4)
            if opposition.get(card) == cycle:
                price = (price[0], price[1], price[2] + 1)

            contributions = {
                raw[0]: decode(raw[1:]) for raw in raw_contributions.split(',')
            }
            actual = tuple(map(sum, zip(*contributions.values())))
            assert actual == price, (name, cycle, card, actual, price)
            if card in PERSONAL:
                assert set(contributions) == {PERSONAL[card]}
            if card in REPRESENTATION:
                partner = REPRESENTATION[card]
                assert set(contributions) == {'O', partner}
                assert partner not in representatives
            for team, contribution in contributions.items():
                assert sum(contribution) > 0
                change(balances[team], contribution, -1)
                change(spent[team], contribution)
                assert min(balances[team]) >= 0, (name, cycle, card, team, balances[team])
            if card in ('R3', 'R4', 'R5'):
                assert len(contributions) == 1
            paid[card].append(tuple(contributions))

            is_complete = len(paid[card]) == units
            project_rows.append((name, cycle, card, len(paid[card]), raw_contributions, '/'.join(map(str, price)), is_complete))
            if is_complete:
                complete[card] = cycle
                for team, effect in zip(TEAMS, SCORES.get(card, ())):
                    score[team] += effect
                if card in REPRESENTATION:
                    representatives[REPRESENTATION[card]] = cycle
                if card == 'O3':
                    assert 'T2' not in complete and cycle >= 4 and ('T1X' if compromise else 'T1') in ready_before
                    opposition['T2'] = cycle + 1

        for team in TEAMS:
            expected = [old + gain - out - paid_amount for old, gain, out, paid_amount in zip(before[team], received[team], sent[team], spent[team])]
            assert balances[team] == expected
            capture(cycle, team, incoming[team], before[team], received[team], sent[team], spent[team])

    assert (len(paid['C1']), len(paid['T1X']), len(paid['T2'])) == ((1, 1, 1) if compromise else (2, 0, 2))
    assert ('R1' in complete) == repair
    assert len(representatives) == 2
    return team_rows, project_rows


if __name__ == '__main__':
    success_teams, success_projects = replay('square', SUCCESS, ('SSSQSR',))
    fail_teams, fail_projects = replay('compromise', COMPROMISE, ('SRSQQR', 'SRSCCR'), repair=True)
    unremediated_plan = dict(COMPROMISE)
    trades, actions = unremediated_plan[5]
    unremediated_plan[5] = (trades, actions.replace('R1:A012,M101 ', '', 1))
    unrepaired_teams, _ = replay('no_repair', unremediated_plan, ('SRSQQR', 'SRSCCR'))
    repair_rows = {r[2]: r for r in fail_teams if r[1] == 6}
    no_repair_rows = {r[2]: r for r in unrepaired_teams if r[1] == 6}
    assert repair_rows['M'][-4] == no_repair_rows['M'][-4]
    assert repair_rows['A'][-3] == no_repair_rows['A'][-3] - 1
    assert repair_rows['J'][-1] == no_repair_rows['J'][-1] + 1
    team_header = ['trace', 'cycle', 'team'] + [f'{key}_{resource}' for key in ('net_income', 'before_trade', 'received', 'sent', 'spent', 'end') for resource in ('wood', 'stone', 'work')] + ['score_or_order_representations']
    project_header = ['trace', 'cycle', 'card', 'unit', 'contributions', 'wood/stone/work', 'completed']
    folder = Path(__file__).parent
    if '--write-csv' in sys.argv:
        for filename, header, rows in (('teams.csv', team_header, success_teams + fail_teams), ('units.csv', project_header, success_projects + fail_projects)):
            with (folder / filename).open('w', newline='', encoding='utf-8') as file:
                writer = csv.writer(file)
                writer.writerow(header)
                writer.writerows(rows)
    for rows in (success_teams, fail_teams):
        for cycle in range(7):
            print(rows[0][0], cycle, ' '.join(f'{row[2]}:{"/".join(map(str, row[-4:-1]))}@{row[-1]}' for row in rows if row[1] == cycle))
    print(f'Checked {len(success_teams) + len(fail_teams)} team snapshots and {len(success_projects) + len(fail_projects)} funded units.')
    print('Controlled check: without repair, final merchant wood stays the same, administration keeps one more stone, and residents lose one point.')
