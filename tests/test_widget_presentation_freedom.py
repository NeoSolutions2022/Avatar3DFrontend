import json
import os
import subprocess
import sys
import unittest

from app.config import _elia_presentation_freedom


class EliaPresentationFreedomTests(unittest.TestCase):
    def test_optional_freedom_range_and_explicit_zero(self):
        for value in ["", " ", "oops", "NaN", "inf", "-Infinity"]:
            self.assertIsNone(_elia_presentation_freedom(value))
        for value, expected in [("0", 0), ("0.5", .5), ("1", 1), ("2", 1), ("-1", 0)]:
            self.assertEqual(_elia_presentation_freedom(value), expected)

    def test_environment_independent_of_speed_loaded_on_startup(self):
        for value, expected in [("", None), ("0", 0), ("0.5", .5), ("2", 1), ("NaN", None)]:
            env = dict(os.environ, AVATAR3D_ELIA_PRESENTATION_FREEDOM=value, AVATAR3D_ELIA_PLAYBACK_SPEED="1.5")
            result = subprocess.check_output([sys.executable, "-c", "import json;from app.config import Settings;s=Settings();print(json.dumps([s.elia_presentation_freedom,s.elia_playback_speed]))"], env=env, text=True)
            self.assertEqual(json.loads(result), [expected, 1.5])


if __name__ == "__main__":
    unittest.main()
