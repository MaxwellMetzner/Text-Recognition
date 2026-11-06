import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'python'))
import ocr_engine as engine


class ModelReuseTests(unittest.TestCase):
    def tearDown(self):
        engine.EASYOCR_READERS.clear()
        engine.PADDLE_OCR_ENGINES.clear()
        engine.get_docling_converter.cache_clear()
        engine.check_gpu_availability.cache_clear()

    def test_easyocr_reuses_matching_reader_but_separates_languages_and_device(self):
        reader = Mock(side_effect=lambda *args, **kwargs: object())
        with patch.dict(sys.modules, {'easyocr': SimpleNamespace(Reader=reader)}):
            first = engine.get_easyocr_reader(['en'], False)
            self.assertIs(first, engine.get_easyocr_reader(['en'], False))
            self.assertIsNot(first, engine.get_easyocr_reader(['fr', 'en'], False))
            self.assertIsNot(first, engine.get_easyocr_reader(['en'], True))
        self.assertEqual(reader.call_count, 3)

    def test_paddle_shares_equivalent_modes_but_separates_configuration(self):
        constructor = Mock(side_effect=lambda **kwargs: object())
        with patch.dict(
            sys.modules, {'paddleocr': SimpleNamespace(PaddleOCR=constructor)}
        ):
            engines = {}
            for mode in ('fast', 'balanced', 'best', 'document'):
                options = {'ocrMode': mode}
                first = engine.get_paddle_ocr('en', False, options)
                engines[mode] = first
                self.assertIs(first, engine.get_paddle_ocr('en', False, options))
            self.assertIs(engines['best'], engines['document'])
            self.assertIsNot(engines['fast'], engines['balanced'])
            self.assertIsNot(engines['balanced'], engines['best'])
            self.assertIsNot(
                engines['best'], engine.get_paddle_ocr('fr', False, {'ocrMode': 'best'})
            )
            self.assertIsNot(
                engines['best'], engine.get_paddle_ocr('en', True, {'ocrMode': 'best'})
            )
        self.assertEqual(constructor.call_count, 5)

    def test_docling_converter_is_reused(self):
        constructor = Mock(return_value=object())
        with patch.dict(sys.modules, {
            'docling': SimpleNamespace(),
            'docling.document_converter': SimpleNamespace(DocumentConverter=constructor),
        }):
            self.assertIs(engine.get_docling_converter(), engine.get_docling_converter())
        constructor.assert_called_once_with()

    def test_gpu_probe_is_cached(self):
        available = Mock(return_value=True)
        with patch.dict(sys.modules, {
            'torch': SimpleNamespace(cuda=SimpleNamespace(is_available=available)),
        }):
            self.assertTrue(engine.check_gpu_availability())
            self.assertTrue(engine.check_gpu_availability())
        available.assert_called_once_with()


class RecognitionCoverageTests(unittest.TestCase):
    def test_tesseract_reuses_file_without_removing_any_passes(self):
        api = SimpleNamespace(
            image_to_data=Mock(return_value={}),
            image_to_string=Mock(return_value='Recognized text'),
            Output=SimpleNamespace(DICT='dict'),
        )
        result = {'text': 'Recognized text', 'confidence': 95}
        options = engine.load_options('{"ocrMode":"fast"}')
        with (
            patch.dict(sys.modules, {'pytesseract': api}),
            patch.object(engine, 'resolve_tesseract_path'),
            patch.object(engine, 'build_ocr_result', return_value=result),
        ):
            self.assertEqual(engine.ocr_with_tesseract('prepared.png', options), result)
        self.assertEqual(api.image_to_data.call_count, 6)
        self.assertEqual(api.image_to_string.call_count, 6)
        for call in api.image_to_data.call_args_list + api.image_to_string.call_args_list:
            self.assertEqual(call.args[0], os.path.abspath('prepared.png'))
        configs = [call.kwargs['config'] for call in api.image_to_data.call_args_list]
        self.assertEqual(sum('load_system_dawg=0' in config for config in configs), 2)

    def test_mode_candidate_coverage_is_unchanged(self):
        page = engine.PreparedPage('prepared.png', 1, 100, 100, 'source.png', [])
        result = {'text': 'A sufficiently long recognized result', 'confidence': 95}
        for mode, expected in (
            ('fast', (1, 0, 0)),
            ('balanced', (1, 1, 0)),
            ('best', (1, 1, 1)),
            ('document', (1, 1, 1)),
        ):
            with (
                self.subTest(mode=mode),
                patch.object(engine, 'ocr_with_tesseract', return_value=result) as tess,
                patch.object(engine, 'ocr_with_paddleocr', return_value=result) as paddle,
                patch.object(engine, 'ocr_with_easyocr', return_value=result) as easy,
            ):
                best, candidates = engine.run_ocr_on_page(
                    page, {'ocrMode': mode}, False, 'temporary'
                )
                self.assertEqual(best, result)
                self.assertEqual(len(candidates), sum(expected))
                self.assertEqual((tess.call_count, paddle.call_count, easy.call_count), expected)

    def test_fast_still_falls_back_when_needed(self):
        page = engine.PreparedPage('prepared.png', 1, 100, 100, 'source.png', [])
        with (
            patch.object(engine, 'ocr_with_tesseract', return_value=None),
            patch.object(engine, 'ocr_with_paddleocr', return_value=None) as paddle,
        ):
            self.assertEqual(
                engine.run_ocr_on_page(page, {'ocrMode': 'fast'}, False, 'temporary'),
                (None, []),
            )
        paddle.assert_called_once()


class WorkerProtocolTests(unittest.TestCase):
    def test_worker_handles_multiple_requests_errors_and_native_logs(self):
        script = '''
import os
import ocr_engine as engine
count = 0
def process(paths, options):
    global count
    count += 1
    print("model initialization log", flush=True)
    os.write(1, b"native initialization log\\n")
    return {'success': True, 'count': count, 'paths': paths, 'mode': options['ocrMode']}
engine.process_inputs = process
engine.collect_environment_diagnostics = lambda: {'success': True, 'doctor': True}
engine.run_worker()
'''
        requests = [
            {'id': 1, 'args': ['sc\u00e4n.png', '{"ocrMode":"fast"}']},
            {'id': 2, 'args': ['--unknown-flag']},
            {'id': 3, 'args': ['second.png', '{"ocrMode":"best"}']},
            {'id': 4, 'args': ['--doctor']},
        ]
        completed = subprocess.run(
            [sys.executable, '-u', '-c', script],
            input=''.join(json.dumps(request) + '\n' for request in requests),
            text=True, encoding='utf-8', capture_output=True, timeout=30,
            env={**os.environ, 'PYTHONPATH': str(Path(engine.__file__).parent),
                 'PYTHONIOENCODING': 'utf-8'},
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        responses = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual([response['id'] for response in responses], [1, 2, 3, 4])
        self.assertEqual(responses[0]['result']['paths'], ['sc\u00e4n.png'])
        self.assertFalse(responses[1]['result']['success'])
        self.assertEqual(responses[2]['result']['count'], 2)
        self.assertEqual(responses[2]['result']['mode'], 'best')
        self.assertTrue(responses[3]['result']['doctor'])
        self.assertIn('native initialization log', completed.stderr)
        self.assertIn('model initialization log', completed.stderr)

    def test_cli_retains_single_result_and_exit_status(self):
        completed = subprocess.run(
            [sys.executable, engine.__file__, 'missing-input.png', '{}'],
            text=True, encoding='utf-8', capture_output=True, timeout=30,
        )
        self.assertEqual(completed.returncode, 1)
        self.assertFalse(json.loads(completed.stdout)['success'])


if __name__ == '__main__':
    unittest.main()
