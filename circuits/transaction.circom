pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// Zerith join-split transaction: spends up to nIns notes and creates nOuts notes, with an
// optional public amount entering (deposit) or leaving (withdrawal + relayer fee) the pool.
//
// Note (UTXO):
//   ownerPub   = Poseidon(ownerPriv)                       (same keys as the Zerith shld1 address)
//   commitment = Poseidon(amount, ownerPub, blinding)
//   nullifier  = Poseidon(ownerPriv, commitment, leafIndex)
//
// Balance: sum(inAmount) + publicAmount === sum(outAmount)   (mod p)
//   publicAmount = extAmount - fee, computed by the contract. extAmount > 0 is a deposit,
//   extAmount < 0 a withdrawal, 0 a private transfer.
//
// extDataHash binds everything the proof does not constrain directly (recipient, relayer,
// fee, extAmount, encrypted outputs), so a relayer cannot change any of it.

// Merkle inclusion with the path given as a leaf index; Num2Bits also bounds the index.
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices;
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== pathIndices;

    component hashers[levels];
    signal cur[levels + 1];
    signal left[levels];
    signal right[levels];
    cur[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        // bit = 1: the current node is the right child.
        left[i] <== cur[i] + bits.out[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + bits.out[i] * (cur[i] - pathElements[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        cur[i + 1] <== hashers[i].out;
    }
    root <== cur[levels];
}

template Transaction(levels, nIns, nOuts) {
    // public
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // private: inputs
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    // private: outputs
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    component inKey[nIns];
    component inCommit[nIns];
    component inNullifier[nIns];
    component inTree[nIns];
    component inRootCheck[nIns];
    var sumIns = 0;

    for (var i = 0; i < nIns; i++) {
        inKey[i] = Poseidon(1);
        inKey[i].inputs[0] <== inPrivateKey[i];

        inCommit[i] = Poseidon(3);
        inCommit[i].inputs[0] <== inAmount[i];
        inCommit[i].inputs[1] <== inKey[i].out;
        inCommit[i].inputs[2] <== inBlinding[i];

        inNullifier[i] = Poseidon(3);
        inNullifier[i].inputs[0] <== inPrivateKey[i];
        inNullifier[i].inputs[1] <== inCommit[i].out;
        inNullifier[i].inputs[2] <== inPathIndices[i];
        inNullifier[i].out === inputNullifier[i];

        inTree[i] = MerkleProof(levels);
        inTree[i].leaf <== inCommit[i].out;
        inTree[i].pathIndices <== inPathIndices[i];
        for (var j = 0; j < levels; j++) {
            inTree[i].pathElements[j] <== inPathElements[i][j];
        }

        // Zero-amount inputs are padding and need not exist in the tree.
        inRootCheck[i] = ForceEqualIfEnabled();
        inRootCheck[i].in[0] <== root;
        inRootCheck[i].in[1] <== inTree[i].root;
        inRootCheck[i].enabled <== inAmount[i];

        // Non-padding inputs come from range-checked outputs, so they are already < 2^248.
        sumIns += inAmount[i];
    }

    component outCommit[nOuts];
    component outAmountCheck[nOuts];
    var sumOuts = 0;

    for (var i = 0; i < nOuts; i++) {
        outCommit[i] = Poseidon(3);
        outCommit[i].inputs[0] <== outAmount[i];
        outCommit[i].inputs[1] <== outPubkey[i];
        outCommit[i].inputs[2] <== outBlinding[i];
        outCommit[i].out === outputCommitment[i];

        // Bounds every amount so sums cannot wrap around the field.
        outAmountCheck[i] = Num2Bits(248);
        outAmountCheck[i].in <== outAmount[i];

        sumOuts += outAmount[i];
    }

    // The same note cannot be spent twice in one transaction.
    component sameNullifiers[nIns * (nIns - 1) / 2];
    var k = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNullifiers[k] = IsEqual();
            sameNullifiers[k].in[0] <== inputNullifier[i];
            sameNullifiers[k].in[1] <== inputNullifier[j];
            sameNullifiers[k].out === 0;
            k++;
        }
    }

    sumIns + publicAmount === sumOuts;

    // Bind extDataHash to the proof.
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(20, 2, 2);
