import json
import os
import subprocess
import sys
import unittest

from app.config import _elia_playback_speed


class EliaPlaybackSpeedTests(unittest.TestCase):
    def test_parse_and_clamp(self):
        for value in ["", " ", "oops", "NaN", "inf", "-Infinity"]:
            self.assertIsNone(_elia_playback_speed(value))
        for value, expected in [("1.5", 1.5), ("1.2", 1.2), ("2", 1.5), ("0", .5), ("-1", .5)]:
            self.assertEqual(_elia_playback_speed(value), expected)

    def test_environment_is_loaded_on_process_start(self):
        for value, expected in [("", None), ("1.5", 1.5), ("2", 1.5), ("NaN", None)]:
            env = dict(os.environ, AVATAR3D_ELIA_PLAYBACK_SPEED=value)
            result = subprocess.check_output([sys.executable, "-c", "import json;from app.config import Settings;print(json.dumps(Settings().elia_playback_speed))"], env=env, text=True)
            self.assertEqual(json.loads(result), expected)


if __name__ == "__main__":
    unittest.main()
