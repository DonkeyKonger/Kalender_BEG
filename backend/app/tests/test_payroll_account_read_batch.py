from sqlalchemy import event

from app.services.payroll_month_account_service import PayrollMonthAccountService
from app.services.person_hours_account_service import PersonHoursAccountService
from app.tests.test_payroll_daily_ledger_service import db_session, configured_worker
from app.tests.test_payroll_month_account_service import post


def test_account_reuses_history_for_balance_and_notices_without_changing_results():
    with db_session() as db:
        person, _user, _ledger = configured_worker(db, [480] * 5 + [0, 0], opening_minutes=6000)
        monthly = PayrollMonthAccountService(db)
        post(monthly, person, delta=None)
        db.commit()
        expected_balance = monthly.current_balance(person.id)
        expected_notices = monthly.notices(person.id)
        statements = []
        def record(_conn, _cursor, statement, _params, _context, _many):
            if statement.lstrip().upper().startswith('SELECT') and 'FROM person_hours_account_entries' in statement:
                statements.append(statement)
        event.listen(db.bind, 'before_cursor_execute', record)
        account = PersonHoursAccountService(db).get_account(person_id=person.id)
        event.remove(db.bind, 'before_cursor_execute', record)
        assert account.current_balance_minutes == expected_balance
        assert account.notices == expected_notices
        assert len(statements) == 1
        assert len(account.entries) == 2
