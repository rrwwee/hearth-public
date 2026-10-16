import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.getcwd(), 'test'))
import test_deploy_bundle

measurements = []
original_setup = test_deploy_bundle.BundleDeploymentTests.setUp
def setup(self):
    start = time.perf_counter()
    try:
        return original_setup(self)
    finally:
        self.profile_setup_s = time.perf_counter() - start
test_deploy_bundle.BundleDeploymentTests.setUp = setup

class Result(unittest.TextTestResult):
    def startTest(self, test):
        self.profile_start = time.perf_counter()
        super().startTest(test)
    def stopTest(self, test):
        measurements.append(dict(test=test.id(), duration_s=time.perf_counter() - self.profile_start, setup_s=getattr(test, 'profile_setup_s', None)))
        super().stopTest(test)

suite = unittest.defaultTestLoader.loadTestsFromModule(test_deploy_bundle)
result = unittest.TextTestRunner(resultclass=Result).run(suite)
print(json.dumps(measurements, indent=2))
raise SystemExit(not result.wasSuccessful())
