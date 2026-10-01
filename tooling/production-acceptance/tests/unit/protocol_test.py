import importlib.util
import json
import pathlib
import unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('protocol', ROOT / 'guest/protocol.py')
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)
vectors = json.loads((ROOT / 'contracts/vectors.json').read_text())

class ContractsTests(unittest.TestCase):
    def reject_group(self, group):
        self.assertTrue(any(v['group'] == group for v in vectors['rejected']), group)
        for vector in vectors['rejected']:
            if vector['group'] == group:
                with self.subTest(vector=vector['name']):
                    with self.assertRaises(protocol.InvalidFrame):
                        protocol.decode_frame(vector['json'].encode(), vector['kind'])
    def test_unknown_field_rejected(self): self.reject_group('unknown_field_rejected')
    def test_duplicate_key_rejected(self): self.reject_group('duplicate_key_rejected')
    def test_oversized_frame_rejected(self): self.reject_group('oversized_frame_rejected')
    def test_arbitrary_url_host_rejected(self): self.reject_group('arbitrary_url_host_rejected')
    def test_invalid_phase_event_rejected(self): self.reject_group('invalid_phase_event_rejected')
    def test_private_fields_not_public(self): self.reject_group('private_fields_not_public')
    def test_runtime_identity_requires_exact_hashes(self): self.reject_group('runtime_identity_requires_exact_hashes')
    def test_malformed_values_rejected(self): self.reject_group('malformed_values_rejected')
    def test_canonical_receipt_bytes_equal(self):
        self.assertTrue(vectors['accepted'])
        for v in vectors['accepted']:
            with self.subTest(vector=v['name']):
                frame = protocol.decode_frame((' \n'+v['json']+' \t').encode(), v['kind'])
                self.assertEqual(protocol.canonical_bytes(frame), v['canonical'].encode())
    def test_public_run_total_bounded(self):
        v = next(v for v in vectors['accepted'] if v['name'] == 'public_phase')
        frame = protocol.decode_frame(v['json'].encode(), v['kind'])
        size = len(v['canonical'].encode()); count = 262144 // size
        budget = protocol.PublicRunBudget()
        for _ in range(count): budget.append(frame)
        self.assertEqual(budget.used_bytes, count * size)
        with self.assertRaises(protocol.InvalidFrame): budget.append(frame)
        self.assertEqual(budget.used_bytes, count * size)
        with self.assertRaises(protocol.InvalidFrame):
            budget.append(protocol.decode_frame(vectors['accepted'][0]['json'].encode(), 'CONTROL'))
    def test_strict_utf8_and_canonical_revalidation(self):
        with self.assertRaises(protocol.InvalidFrame): protocol.decode_frame(b'\xff', 'CONTROL')
        frame = protocol.decode_frame(vectors['accepted'][0]['json'].encode(), 'CONTROL')
        frame['payload']['event'] = 'login'
        with self.assertRaises(protocol.InvalidFrame): protocol.canonical_bytes(frame)

if __name__ == '__main__': unittest.main()
