"""Exercise the lease policy without SSH processes, credentials or networking."""
import ast
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

tree = ast.parse(Path(__file__).with_name('tunnel-guard.py').read_text())
functions = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef)], type_ignores=[])


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.scope = {'os': MagicMock(), 'pwd': MagicMock(), 'subprocess': MagicMock()}
        exec(compile(functions, 'tunnel-guard.py', 'exec'), self.scope)

    def test_persistent_failure_closes_lease_after_three_probes(self):
        check, pause, terminate = MagicMock(return_value=False), MagicMock(), MagicMock()
        self.scope['monitor'](check, pause, terminate)
        self.assertEqual(check.call_count, 3)
        self.assertEqual(pause.call_count, 2)
        terminate.assert_called_once_with()

    def test_success_resets_failure_count(self):
        check = MagicMock(side_effect=[False, False, True, False, False, False])
        terminate = MagicMock()
        self.scope['monitor'](check, MagicMock(), terminate)
        self.assertEqual(check.call_count, 6)
        terminate.assert_called_once_with()

    def test_adopted_or_changed_parent_is_rejected(self):
        self.scope['os'].getppid.return_value = 300
        for parent in [1, 200]:
            with self.assertRaises(RuntimeError):
                self.scope['validate_parent'](parent)
        self.scope['subprocess'].check_output.assert_not_called()

    def test_unrelated_same_user_parent_is_rejected(self):
        self.scope['os'].getppid.return_value = 200
        self.scope['os'].getuid.return_value = 1000
        self.scope['os'].stat.return_value = SimpleNamespace(st_uid=1000)
        self.scope['pwd'].getpwuid.return_value = SimpleNamespace(pw_name='lmo0317')
        self.scope['subprocess'].check_output.side_effect = ['1000\n', 'sshd: lmo0317\n']
        with self.assertRaises(RuntimeError):
            self.scope['validate_parent'](200)

    def test_only_direct_same_user_command_session_is_accepted(self):
        self.scope['os'].getppid.return_value = 200
        self.scope['os'].getuid.return_value = 1000
        self.scope['os'].stat.return_value = SimpleNamespace(st_uid=1000)
        self.scope['pwd'].getpwuid.return_value = SimpleNamespace(pw_name='lmo0317')
        self.scope['subprocess'].check_output.side_effect = ['1000\n', 'sshd: lmo0317@notty\n']
        self.scope['validate_parent'](200)


if __name__ == '__main__':
    unittest.main()
